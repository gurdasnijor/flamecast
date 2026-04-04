/**
 * AgentSession — Restate Virtual Object, keyed by sessionId.
 *
 * Every handler spawns a fresh agent process from durable K/V state.
 * No module-level cache. No mutable Maps. The process lives for the
 * duration of the handler invocation and is cleaned up after.
 *
 * K/V state (set by init, read by every handler):
 *   - clientId, agentName, spawnConfig, acpSessionId, cwd
 *   - updates[] (accumulated sessionUpdate notifications)
 *   - pendingPermission (current awakeable for permission request)
 *
 * Type-checked against acp.Agent via RestateAgentSession mapped type.
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import { execa, type ResultPromise } from "execa";
import { Readable, Writable } from "node:stream";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ─── Type safety: VO handlers must match acp.Agent ──────────────────────

type RestateAgentSession = {
  [K in "prompt" | "cancel"]: Required<acp.Agent>[K] extends (...args: infer A) => infer R
    ? (ctx: restate.ObjectContext, ...args: A) => R
    : never;
} & {
  init: (ctx: restate.ObjectContext, params: InitParams) => Promise<void>;
  getPendingPermission: (ctx: restate.ObjectSharedContext) => Promise<PendingPermission | null>;
  getUpdates: (ctx: restate.ObjectSharedContext) => Promise<acp.SessionNotification[]>;
};

interface InitParams {
  clientId: string;
  agentName: string;
  spawnConfig: Record<string, unknown> | null;
  cwd: string;
  mcpServers: acp.NewSessionRequest["mcpServers"];
}

interface PendingPermission {
  awakeableId: string;
  toolCall: acp.RequestPermissionRequest["toolCall"];
  options: acp.RequestPermissionRequest["options"];
}

interface SpawnConfig {
  type: "npx";
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

// ─── Spawn a fresh connection for this handler invocation ───────────────

function spawnForHandler(ctx: restate.ObjectContext, config: SpawnConfig): {
  conn: acp.ClientSideConnection;
  proc: ResultPromise;
} {
  const proc = execa(config.cmd, config.args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cleanup: true,
    env: { ...process.env, ...config.env },
  });
  proc.catch(() => {});

  // The acp.Client — uses ctx directly (no mutable ref needed, ctx is live for this handler)
  const conn = new acp.ClientSideConnection(
    () => ({
      async sessionUpdate(p: acp.SessionNotification) {
        const updates = (await ctx.get<acp.SessionNotification[]>("updates")) ?? [];
        updates.push(p);
        ctx.set("updates", updates);
      },

      async requestPermission(p: acp.RequestPermissionRequest) {
        const { id, promise } = ctx.awakeable<acp.RequestPermissionOutcome>();
        ctx.set("pendingPermission", {
          awakeableId: id,
          toolCall: p.toolCall,
          options: p.options,
        } satisfies PendingPermission);
        const outcome = await promise;
        ctx.clear("pendingPermission");
        return { outcome };
      },

      async readTextFile(p: acp.ReadTextFileRequest) {
        return { content: await readFile(p.path, "utf-8") };
      },

      async writeTextFile(p: acp.WriteTextFileRequest) {
        await mkdir(dirname(p.path), { recursive: true });
        await writeFile(p.path, p.content, "utf-8");
        return {};
      },
    }),
    acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout! as import("node:stream").Readable) as ReadableStream<Uint8Array>,
    ),
  );

  return { conn, proc };
}

/**
 * Spawn a fresh agent process, initialize it, and restore the ACP session.
 * Called at the start of every handler that needs the downstream connection.
 */
async function connectAgent(ctx: restate.ObjectContext): Promise<{
  conn: acp.ClientSideConnection;
  proc: ResultPromise;
}> {
  const config = await ctx.get<SpawnConfig>("spawnConfig");
  const acpSessionId = await ctx.get<string>("acpSessionId");
  const cwd = (await ctx.get<string>("cwd")) ?? "/";

  if (!config) {
    throw new restate.TerminalError("No session — call init first");
  }

  const { conn, proc } = spawnForHandler(ctx, config);

  await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "flamecast", title: "Flamecast", version: "0.1.0" },
  });

  if (acpSessionId) {
    // Existing session — try loadSession, fall back to newSession
    try {
      await conn.loadSession({ sessionId: acpSessionId, cwd, mcpServers: [] });
    } catch {
      // Agent doesn't support loadSession or doesn't recognize the session — create fresh
      const session = await conn.newSession({ cwd, mcpServers: [] });
      ctx.set("acpSessionId", session.sessionId);
    }
  }

  return { conn, proc };
}

// ─── CDN config resolution ──────────────────────────────────────────────

const CDN_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

async function resolveSpawnConfig(agentName: string): Promise<SpawnConfig> {
  const res = await fetch(CDN_URL);
  if (!res.ok) throw new Error(`CDN registry fetch failed: ${res.status}`);
  type CdnAgent = { id: string; distribution: { npx?: { package: string; args?: string[]; env?: Record<string, string> } } };
  const { agents } = (await res.json()) as { agents: CdnAgent[] };
  const agent = agents.find((a) => a.id === agentName);
  if (!agent?.distribution.npx) throw new Error(`Agent "${agentName}" not found in registry`);
  return {
    type: "npx",
    cmd: "npx",
    args: [agent.distribution.npx.package, ...(agent.distribution.npx.args ?? [])],
    env: agent.distribution.npx.env,
  };
}

// ─── Virtual Object ─────────────────────────────────────────────────────

export const AgentSession = restate.object<string, RestateAgentSession>({
  name: "AgentSession",
  handlers: {
    init: restate.handlers.object.exclusive(
      async (ctx: restate.ObjectContext, params: InitParams): Promise<void> => {
        ctx.set("clientId", params.clientId);
        ctx.set("agentName", params.agentName);
        ctx.set("cwd", params.cwd);
        ctx.set("updates", []);

        // Resolve spawn config: from _meta (tests) or CDN (production)
        const spawnConfig = params.spawnConfig
          ? (params.spawnConfig as unknown as SpawnConfig)
          : await ctx.run("resolve-config", () => resolveSpawnConfig(params.agentName));
        ctx.set("spawnConfig", spawnConfig);

        // Spawn, initialize, create session — then kill the process
        // (next handler invocation will respawn from K/V)
        const { conn, proc } = spawnForHandler(ctx, spawnConfig);

        const initResponse = await conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: "flamecast", title: "Flamecast", version: "0.1.0" },
        });
        ctx.set("agentCapabilities", initResponse.agentCapabilities);

        const session = await conn.newSession({
          cwd: params.cwd,
          mcpServers: params.mcpServers,
        });
        ctx.set("acpSessionId", session.sessionId);

        // Process cleanup — init is done, next handler will spawn fresh
        proc.kill();
      },
    ),

    async prompt(ctx: restate.ObjectContext, params: acp.PromptRequest): Promise<acp.PromptResponse> {
      const { conn, proc } = await connectAgent(ctx);
      try {
        return await conn.prompt(params);
      } finally {
        proc.kill();
      }
    },

    cancel: restate.handlers.object.shared(
      async (_ctx: restate.ObjectSharedContext, _params: acp.CancelNotification): Promise<void> => {
        // Cancel is best-effort: if the prompt handler's process is running,
        // the exclusive lock means cancel can't run until prompt finishes.
        // For real cancellation, use Restate invocation cancellation:
        //   restate invocations cancel <invocationId>
        // TODO: store invocation ID in K/V for programmatic cancellation
      },
    ),

    getPendingPermission: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<PendingPermission | null> => {
        return (await ctx.get<PendingPermission>("pendingPermission")) ?? null;
      },
    ),

    getUpdates: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<acp.SessionNotification[]> => {
        return (await ctx.get<acp.SessionNotification[]>("updates")) ?? [];
      },
    ),
  },
});
