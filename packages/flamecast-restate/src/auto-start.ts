import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Http2Server } from "node:http2";
import { homedir, platform, arch } from "node:os";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createRestateEndpoint } from "./endpoint.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoStartOptions {
  /** Ingress port. Defaults to 18080. */
  ingressPort?: number;
  /** Admin port. Defaults to 19070. */
  adminPort?: number;
}

export interface AutoStartResult {
  ingressUrl: string;
  adminUrl: string;
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the platform-specific Restate binary path.
 *
 * The `@restatedev/restate-server` package delegates to a platform-specific
 * package named `@restatedev/restate-server-<platform>-<arch>`. We replicate
 * its `getExePath()` logic here so we can spawn the binary directly rather
 * than going through the wrapper script.
 *
 * The user must install `@restatedev/restate-server` as a dependency when
 * they opt into the Restate runtime — it is intentionally NOT listed in this
 * package's dependencies.
 */
function resolveRestateBinary(): string {
  const thisRequire = createRequire(import.meta.url);

  // Resolve via @restatedev/restate-server's own require context, so pnpm's
  // strict module isolation can find the platform-specific binary package
  // (it's a dependency of restate-server, not of our package).
  let serverPkgPath: string;
  try {
    serverPkgPath = thisRequire.resolve(
      "@restatedev/restate-server/package.json",
    );
  } catch {
    throw new Error(
      `Could not find @restatedev/restate-server. ` +
        `Install it with: pnpm add @restatedev/restate-server`,
    );
  }

  const serverRequire = createRequire(serverPkgPath);
  const op = platform();
  const ar = arch();

  try {
    return serverRequire.resolve(
      `@restatedev/restate-server-${op}-${ar}/bin/restate-server`,
    );
  } catch {
    throw new Error(
      `Could not find the Restate server binary for ${op}-${ar}. ` +
        `Install it with: pnpm add @restatedev/restate-server`,
    );
  }
}

// ---------------------------------------------------------------------------
// Deployment registration
// ---------------------------------------------------------------------------

/**
 * Register a service endpoint with Restate via the admin API.
 *
 * POST /deployments { uri: "<endpoint>" }
 * Retries a few times since Restate may not be fully ready immediately after
 * the ports are printed.
 */
async function registerDeployment(
  adminUrl: string,
  endpointUrl: string,
): Promise<void> {
  const maxRetries = 10;
  const retryDelay = 500; // ms

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${adminUrl}/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: endpointUrl }),
      });
      if (resp.ok) return;

      const body = await resp.text();
      if (attempt === maxRetries) {
        throw new Error(
          `Failed to register deployment (HTTP ${resp.status}): ${body}`,
        );
      }
    } catch (err) {
      if (attempt === maxRetries) throw err;
    }
    await new Promise((r) => setTimeout(r, retryDelay));
  }
}

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------

/**
 * Start a local Restate server instance, register Flamecast services on it,
 * and return the ingress URL for `RestateSessionService` to connect to.
 *
 * This is intended for local development — it spawns `restate-server` as a
 * managed child process with random ports and persistent state.
 *
 * Usage:
 * ```ts
 * const restate = await autoStartRestate();
 * const sessions = new RestateSessionService(runtimes, restate.ingressUrl);
 * // ... on shutdown:
 * await restate.stop();
 * ```
 */
export async function autoStartRestate(
  opts?: AutoStartOptions,
): Promise<AutoStartResult> {
  const ingressPort = opts?.ingressPort ?? 18080;
  const adminPort = opts?.adminPort ?? 19070;

  // 1. Resolve the binary
  const binaryPath = resolveRestateBinary();

  // 2. Ensure the data directory exists
  const dataDir = path.join(homedir(), ".flamecast", "restate-data");
  await mkdir(dataDir, { recursive: true });

  // 3. Spawn restate-server with fixed ports via env vars
  const child: ChildProcess = spawn(
    binaryPath,
    ["--base-dir", dataDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RESTATE_INGRESS__BIND_PORT: String(ingressPort),
        RESTATE_ADMIN__BIND_PORT: String(adminPort),
      },
    },
  );

  const ingressUrl = `http://localhost:${ingressPort}`;
  const adminUrl = `http://localhost:${adminPort}`;

  // 4. Forward stderr for debugging, detect premature exit
  child.stderr!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.error(`[restate] ${line}`);
    }
  });

  // 5. Wait for Restate to become ready (poll admin health endpoint)
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Restate failed to start within 30s")), 30_000);
    child.on("error", (err) => { clearTimeout(deadline); reject(err); });
    child.on("exit", (code) => { clearTimeout(deadline); reject(new Error(`Restate exited with code ${code}`)); });

    const poll = async () => {
      try {
        const resp = await fetch(`${adminUrl}/health`);
        if (resp.ok) { clearTimeout(deadline); resolve(); return; }
      } catch { /* not ready yet */ }
      setTimeout(poll, 200);
    };
    poll();
  });

  // 6. Start the Flamecast Restate endpoint and register with Restate
  const endpoint = createRestateEndpoint();
  const handler = endpoint.http2Handler();
  const http2Server: Http2Server = createServer(handler);

  const endpointPort = await new Promise<number>((resolve, reject) => {
    http2Server.listen(0, () => {
      const addr = http2Server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to bind Restate endpoint to a random port"));
      }
    });
    http2Server.on("error", reject);
  });

  await registerDeployment(adminUrl, `http://localhost:${endpointPort}`);

  // 7. Return result
  return {
    ingressUrl,
    adminUrl,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        http2Server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.on("exit", () => { clearTimeout(forceKill); resolve(); });
        });
      }
    },
  };
}
