/**
 * AgentSession — Restate Virtual Object, keyed by sessionId.
 *
 * Session-level ACP Agent handlers: prompt, cancel, loadSession.
 * Client callbacks (sessionUpdate, requestPermission) run inline
 * in the prompt handler via the toClient closure — NOT as separate handlers.
 *
 * Type-checked against acp.Agent via RestateAgentSession mapped type.
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import { execa } from "execa";
import { Readable, Writable } from "node:stream";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ─── Type safety: VO handlers must match acp.Agent ──────────────────────

/** Session-scoped subset of acp.Agent, lifted for Restate. */
type RestateAgentSession = {
  [K in "prompt" | "cancel"]: Required<acp.Agent>[K] extends (...args: infer A) => infer R
    ? (ctx: restate.ObjectContext, ...args: A) => R
    : never;
} & {
  /** Internal: called by AgentConnection.newSession to bootstrap this session. */
  init: (ctx: restate.ObjectContext, params: InitParams) => Promise<void>;
  /** Shared: read pending permission for frontend polling. */
  getPendingPermission: (ctx: restate.ObjectSharedContext) => Promise<PendingPermission | null>;
  /** Shared: read accumulated updates for frontend polling. */
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

// ─── Module state (ephemeral cache, rebuilt from K/V on restart) ─────────

interface SessionHandle {
  conn: acp.ClientSideConnection;
}

const sessions = new Map<string, SessionHandle>();

// Mutable ref for the current handler's ctx — set before conn.prompt(), used by toClient closure
let currentCtx: restate.ObjectContext | null = null;

// ─── Spawn ──────────────────────────────────────────────────────────────

interface SpawnConfig {
  type: "npx";
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

function spawnConnection(sessionKey: string, config: SpawnConfig): SessionHandle {
  const proc = execa(config.cmd, config.args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cleanup: true,
    env: { ...process.env, ...config.env },
  });
  proc.catch(() => {});

  const conn = new acp.ClientSideConnection(
    () => ({
      async sessionUpdate(p: acp.SessionNotification) {
        if (!currentCtx) return;
        const updates = (await currentCtx.get<acp.SessionNotification[]>("updates")) ?? [];
        updates.push(p);
        currentCtx.set("updates", updates);
      },

      async requestPermission(p: acp.RequestPermissionRequest) {
        if (!currentCtx) throw new Error("No ctx — requestPermission called outside prompt handler");
        const { id, promise } = currentCtx.awakeable<acp.RequestPermissionOutcome>();
        currentCtx.set("pendingPermission", {
          awakeableId: id,
          toolCall: p.toolCall,
          options: p.options,
        } satisfies PendingPermission);
        const outcome = await promise;
        currentCtx.clear("pendingPermission");
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

  const handle: SessionHandle = { conn };
  sessions.set(sessionKey, handle);

  conn.closed
    .then(() => sessions.delete(sessionKey))
    .catch(() => sessions.delete(sessionKey));

  return handle;
}

async function getOrReconnect(ctx: restate.ObjectContext): Promise<SessionHandle> {
  const cached = sessions.get(ctx.key);
  if (cached) return cached;

  const config = await ctx.get<SpawnConfig>("spawnConfig");
  const acpSessionId = await ctx.get<string>("acpSessionId");
  if (!config || !acpSessionId) {
    throw new restate.TerminalError("No session — call init first");
  }

  const handle = spawnConnection(ctx.key, config);
  await handle.conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "flamecast", title: "Flamecast", version: "0.1.0" },
  });
  await handle.conn.loadSession({ sessionId: acpSessionId, cwd: "/", mcpServers: [] });
  return handle;
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
        ctx.set("updates", []);

        // Resolve spawn config: from _meta (tests) or CDN (production)
        const spawnConfig = params.spawnConfig
          ? (params.spawnConfig as unknown as SpawnConfig)
          : await ctx.run("resolve-config", () => resolveSpawnConfig(params.agentName));
        ctx.set("spawnConfig", spawnConfig);

        // Spawn and initialize downstream agent
        const handle = spawnConnection(ctx.key, spawnConfig);
        currentCtx = ctx;

        const initResponse = await handle.conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: "flamecast", title: "Flamecast", version: "0.1.0" },
        });
        ctx.set("agentCapabilities", initResponse.agentCapabilities);

        const session = await handle.conn.newSession({
          cwd: params.cwd,
          mcpServers: params.mcpServers,
        });
        ctx.set("acpSessionId", session.sessionId);

        currentCtx = null;
      },
    ),

    async prompt(ctx: restate.ObjectContext, params: acp.PromptRequest): Promise<acp.PromptResponse> {
      const handle = await getOrReconnect(ctx);
      currentCtx = ctx;
      try {
        return await handle.conn.prompt(params);
      } finally {
        currentCtx = null;
      }
    },

    cancel: restate.handlers.object.shared(
      async (_ctx: restate.ObjectSharedContext, params: acp.CancelNotification): Promise<void> => {
        await sessions.get(params.sessionId)?.conn.cancel(params);
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
