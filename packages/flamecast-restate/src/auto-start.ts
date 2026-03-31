import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { platform, arch } from "node:os";

function resolveRestateBinary(): string {
  const require = createRequire(import.meta.url);
  const serverPkg = require.resolve("@restatedev/restate-server/package.json");
  const serverRequire = createRequire(serverPkg);
  return serverRequire.resolve(
    `@restatedev/restate-server-${platform()}-${arch()}/bin/restate-server`,
  );
}

/**
 * Start a local restate-server and register the Flamecast endpoint with it.
 * Returns a stop function for graceful shutdown.
 */
export async function autoStartRestate(opts?: {
  ingressPort?: number;
  adminPort?: number;
  endpointPort?: number;
}): Promise<{ ingressUrl: string; adminUrl: string; stop: () => void }> {
  const ingressPort = opts?.ingressPort ?? 18080;
  const adminPort = opts?.adminPort ?? 19070;
  const endpointPort = opts?.endpointPort ?? 9080;

  const ingressUrl = `http://localhost:${ingressPort}`;
  const adminUrl = `http://localhost:${adminPort}`;

  const child: ChildProcess = spawn(resolveRestateBinary(), [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      RESTATE_INGRESS__BIND_PORT: String(ingressPort),
      RESTATE_ADMIN__BIND_PORT: String(adminPort),
    },
  });

  // Poll until healthy
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      if ((await fetch(`${adminUrl}/health`)).ok) break;
    } catch {}
  }

  // Register endpoint
  for (let i = 0; i < 10; i++) {
    try {
      const resp = await fetch(`${adminUrl}/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: `http://localhost:${endpointPort}` }),
      });
      if (resp.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    ingressUrl,
    adminUrl,
    stop: () => child.kill("SIGTERM"),
  };
}
