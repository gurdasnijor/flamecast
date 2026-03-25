import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "@e2b/code-interpreter";
import type { Runtime } from "@flamecast/sdk/runtime";

const SESSION_HOST_PORT = 8080;
const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Resolve the @flamecast/session-host package directory (contains dist/ + package.json). */
function resolveSessionHostDir(): string {
  const resolved = import.meta.resolve("@flamecast/session-host");
  return dirname(dirname(fileURLToPath(resolved)));
}

/** Recursively collect all files under a directory as { relativePath, absolutePath } pairs. */
function collectFiles(dir: string, base = dir): { rel: string; abs: string }[] {
  const results: { rel: string; abs: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      // Skip node_modules — we npm install inside the sandbox
      if (entry === "node_modules") continue;
      results.push(...collectFiles(abs, base));
    } else {
      results.push({ rel: relative(base, abs), abs });
    }
  }
  return results;
}

/**
 * E2BRuntime — provisions SessionHosts in E2B sandboxes.
 *
 * Each session gets its own sandbox. Session-host is uploaded and installed
 * dynamically from the @flamecast/session-host package. An optional `setup`
 * script (from the agent template) runs before the agent spawns.
 */
export class E2BRuntime implements Runtime {
  private readonly apiKey: string;
  private readonly baseTemplate: string;
  private readonly sandboxes = new Map<string, { sandboxId: string; hostUrl: string }>();

  constructor(opts: {
    apiKey: string;
    /** E2B sandbox template to use as the base (default: Node.js sandbox). */
    baseTemplate?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.baseTemplate = opts.baseTemplate ?? "base";
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/start") && request.method === "POST") {
      return this.handleStart(sessionId, request);
    }

    if (path.endsWith("/terminate") && request.method === "POST") {
      return this.handleTerminate(sessionId, path);
    }

    return this.proxyRequest(sessionId, path, request);
  }

  async dispose(): Promise<void> {
    for (const [, entry] of this.sandboxes) {
      try {
        const sandbox = await Sandbox.connect(entry.sandboxId, { apiKey: this.apiKey });
        await sandbox.kill();
      } catch {
        // Best-effort
      }
    }
    this.sandboxes.clear();
  }

  // ---------------------------------------------------------------------------
  // Request handlers
  // ---------------------------------------------------------------------------

  private async handleStart(sessionId: string, request: Request): Promise<Response> {
    if (this.sandboxes.has(sessionId)) {
      return jsonResponse({ error: `Session "${sessionId}" already exists` }, 409);
    }

    try {
      const parsed = JSON.parse(await request.text()) as Record<string, unknown>;

      const sandbox = await Sandbox.create(this.baseTemplate, {
        apiKey: this.apiKey,
        timeoutMs: 60 * 60 * 1000,
      });

      try {
        // Upload and install session-host
        await this.installSessionHost(sandbox);

        // Run the user's setup script if provided
        const setup = parsed.setup as string | undefined;
        if (setup) {
          console.log(`[E2BRuntime] Running setup script in sandbox ${sandbox.sandboxId}`);
          const result = await sandbox.commands.run(`cd /workspace && sh -c ${shellQuote(setup)}`, {
            timeoutMs: 5 * 60 * 1000,
          });
          if (result.exitCode !== 0) {
            throw new Error(`Setup script failed (exit ${result.exitCode}): ${result.stderr}`);
          }
        }

        // Start session-host in the background
        await sandbox.commands.run(
          `SESSION_HOST_PORT=${SESSION_HOST_PORT} RUNTIME_SETUP_ENABLED=1 node /session-host/dist/index.js`,
          { background: true },
        );

        const host = sandbox.getHost(SESSION_HOST_PORT);
        const hostUrl = `https://${host}`;

        await this.waitForReady(sandbox, SESSION_HOST_PORT);

        this.sandboxes.set(sessionId, { sandboxId: sandbox.sandboxId, hostUrl });

        // Override workspace to sandbox workspace
        parsed.workspace = "/workspace";

        const resp = await fetch(`${hostUrl}/start`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(parsed),
        });

        const text = await resp.text();
        let result: Record<string, unknown>;
        try {
          result = JSON.parse(text);
        } catch {
          throw new Error(`SessionHost /start failed (${resp.status}): ${text}`);
        }

        if (!resp.ok) {
          throw new Error(`SessionHost /start failed (${resp.status}): ${result.error ?? text}`);
        }

        result.hostUrl = hostUrl;
        result.websocketUrl = `wss://${host}`;

        return new Response(JSON.stringify(result), {
          status: resp.status,
          headers: JSON_HEADERS,
        });
      } catch (err) {
        // Clean up sandbox on failure
        this.sandboxes.delete(sessionId);
        await sandbox.kill().catch(() => {});
        throw err;
      }
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : "Failed to create sandbox" },
        500,
      );
    }
  }

  private async handleTerminate(sessionId: string, path: string): Promise<Response> {
    const entry = this.sandboxes.get(sessionId);
    if (!entry) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const resp = await fetch(`${entry.hostUrl}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
    });

    try {
      const sandbox = await Sandbox.connect(entry.sandboxId, { apiKey: this.apiKey });
      await sandbox.kill();
    } catch {
      // Best-effort cleanup
    }
    this.sandboxes.delete(sessionId);

    return new Response(await resp.text(), {
      status: resp.status,
      headers: JSON_HEADERS,
    });
  }

  private async proxyRequest(
    sessionId: string,
    path: string,
    request: Request,
  ): Promise<Response> {
    const entry = this.sandboxes.get(sessionId);
    if (!entry) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const body = request.method !== "GET" ? await request.text() : undefined;
    const resp = await fetch(`${entry.hostUrl}${path}`, {
      method: request.method,
      headers: JSON_HEADERS,
      body,
    });

    return new Response(await resp.text(), {
      status: resp.status,
      headers: JSON_HEADERS,
    });
  }

  // ---------------------------------------------------------------------------
  // Session-host provisioning
  // ---------------------------------------------------------------------------

  /**
   * Upload session-host's dist/ and package.json to the sandbox, then npm install.
   */
  private async installSessionHost(sandbox: Sandbox): Promise<void> {
    const shDir = resolveSessionHostDir();
    const files = collectFiles(shDir);

    // Upload all files (dist/ + package.json, excluding node_modules)
    for (const file of files) {
      const content = readFileSync(file.abs, "utf8");
      await sandbox.files.write(`/session-host/${file.rel}`, content);
    }

    console.log(`[E2BRuntime] Installing session-host dependencies in sandbox ${sandbox.sandboxId}`);
    const result = await sandbox.commands.run("cd /session-host && npm install --omit=dev", {
      timeoutMs: 2 * 60 * 1000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to install session-host: ${result.stderr}`);
    }
  }

  private async waitForReady(
    sandbox: { getHost(port: number): string },
    port: number,
    timeoutMs = 30_000,
  ): Promise<void> {
    const host = sandbox.getHost(port);
    const healthUrl = `https://${host}/health`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const resp = await fetch(healthUrl);
        if (resp.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`SessionHost not ready after ${timeoutMs}ms`);
  }
}

/** Shell-quote a string for use in sh -c. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
