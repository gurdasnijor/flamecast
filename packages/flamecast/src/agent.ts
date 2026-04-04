/**
 * AcpAgent — Restate Virtual Object implementing acp.Agent.
 *
 * Durable state (survives restarts): agentName, acpSessionId
 * Module state (ephemeral cache): live ClientSideConnection
 *
 * On restart, handlers read durable state, respawn the agent process,
 * and loadSession to resume.
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import { execa } from "execa";
import { Readable, Writable } from "node:stream";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { type SpawnConfig } from "./registry.js";
import { AgentClient } from "./agent-client.js";

// ─── Types ───────────────────────────────────────────────────────────────

interface AgentState {
  agentName: string;
  acpSessionId: string;
}

/** Lifts acp.Agent methods from (params) => R to (ctx, params) => R for Restate. */
type RestateAgent = {
  [K in keyof Required<acp.Agent>]: Required<acp.Agent>[K] extends (...args: infer A) => infer R
    ? (ctx: restate.ObjectContext<AgentState>, ...args: A) => R
    : never;
};

// ─── Module state (ephemeral, lost on restart) ────────────────────────────

interface SessionHandle {
  conn: acp.ClientSideConnection;
  client: AgentClient;
}

const sessions = new Map<string, SessionHandle>();
const agentConfigs = new Map<string, SpawnConfig>();

export function registerAgent(id: string, config: SpawnConfig) {
  agentConfigs.set(id, config);
}

const pubsub = createPubsubClient({
  name: "pubsub",
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

async function getOrReconnect(ctx: restate.ObjectContext<AgentState>): Promise<SessionHandle> {
  const cached = sessions.get(ctx.key);
  if (cached) return cached;

  const agentName = await ctx.get("agentName");
  const acpSessionId = await ctx.get("acpSessionId");
  if (!agentName || !acpSessionId) {
    throw new restate.TerminalError("No session — call initialize + newSession first");
  }

  const handle = spawnSession(agentName, ctx.key);
  await handle.conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "flamecast", title: "Flamecast", version: "0.1.0" },
  });
  await handle.conn.loadSession({ sessionId: acpSessionId, cwd: "/", mcpServers: [] });
  sessions.set(ctx.key, handle);
  return handle;
}

// ─── Virtual Object ────────────────────────────────────────────────────────

export const AcpAgent = restate.object<string, RestateAgent>({
  name: "AcpAgent",
  handlers: {
    async initialize(ctx: restate.ObjectContext<AgentState>, params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
      const agentName = (params._meta?.agentName as string) ?? "claude-acp";
      const handle = spawnSession(agentName, ctx.key);
      sessions.set(ctx.key, handle);
      ctx.set("agentName", agentName);

      // Journal the init result — on replay, spawn still happens but initialize() is skipped
      return ctx.run("initialize", () => handle.conn.initialize(params));
    },

    async newSession(ctx: restate.ObjectContext<AgentState>, params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
      if (!sessions.has(ctx.key) && !(await ctx.get("agentName"))) {
        const agentName = (params._meta?.agentName as string) ?? "claude-acp";
        const handle = spawnSession(agentName, ctx.key);
        sessions.set(ctx.key, handle);
        ctx.set("agentName", agentName);
        await ctx.run("auto-initialize", () => handle.conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: "flamecast", title: "Flamecast", version: "0.1.0" },
        }));
      } else if (!sessions.has(ctx.key)) {
        await getOrReconnect(ctx);
      }

      // Journal sessionId — on replay, newSession() is skipped, stored sessionId used
      const result = await ctx.run("newSession", () =>
        sessions.get(ctx.key)!.conn.newSession(params),
      );
      ctx.set("acpSessionId", result.sessionId);
      return result;
    },

    async prompt(ctx: restate.ObjectContext<AgentState>, params: acp.PromptRequest): Promise<acp.PromptResponse> {
      const handle = await getOrReconnect(ctx);
      return handle.conn.prompt(params);
    },

    // Shared: must run concurrently with an active prompt to cancel it
    cancel: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<AgentState>, params: acp.CancelNotification) => {
        await sessions.get(ctx.key)?.conn.cancel(params);
      },
    ),

    async loadSession(ctx: restate.ObjectContext<AgentState>, params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
      const handle = await getOrReconnect(ctx);
      if (!handle.conn.loadSession) throw new restate.TerminalError("loadSession not supported");
      const result = await handle.conn.loadSession(params);
      ctx.set("acpSessionId", params.sessionId);
      return result;
    },

    // Shared: read-only query, no need to block exclusive handlers
    listSessions: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext<AgentState>, params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> => {
        const handle = sessions.get(ctx.key);
        if (!handle?.conn.listSessions) throw new restate.TerminalError("listSessions not supported");
        return handle.conn.listSessions(params);
      },
    ),

    async setSessionMode(ctx: restate.ObjectContext<AgentState>, params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
      const handle = await getOrReconnect(ctx);
      if (!handle.conn.setSessionMode) throw new restate.TerminalError("setSessionMode not supported");
      return handle.conn.setSessionMode(params) as Promise<acp.SetSessionModeResponse>;
    },

    async setSessionConfigOption(ctx: restate.ObjectContext<AgentState>, params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
      const handle = await getOrReconnect(ctx);
      if (!handle.conn.setSessionConfigOption) throw new restate.TerminalError("setSessionConfigOption not supported");
      return handle.conn.setSessionConfigOption(params);
    },

    async authenticate(ctx: restate.ObjectContext<AgentState>, params: acp.AuthenticateRequest) {
      const handle = sessions.get(ctx.key);
      if (handle) await handle.conn.authenticate(params);
    },

    // ── Unstable / not yet implemented ──────────────────────────────────

    async unstable_forkSession() { throw new restate.TerminalError("Not implemented"); },
    async unstable_resumeSession() { throw new restate.TerminalError("Not implemented"); },
    async unstable_closeSession() { throw new restate.TerminalError("Not implemented"); },
    async unstable_setSessionModel() { throw new restate.TerminalError("Not implemented"); },
    async extMethod() { throw new restate.TerminalError("Not implemented"); },
    async extNotification() { throw new restate.TerminalError("Not implemented"); },
  },
});

// ─── Spawn ─────────────────────────────────────────────────────────────────

function spawnSession(agentName: string, sessionKey: string): SessionHandle {
  const config = agentConfigs.get(agentName);
  if (!config) throw new restate.TerminalError(`Unknown agent: ${agentName}`);
  const dist = config.distribution;
  if (dist.type === "url") throw new restate.TerminalError("Remote agents not yet supported");

  const proc = execa(dist.cmd, dist.args ?? [], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit", cleanup: true,
    env: { ...process.env, ...(dist.type === "npx" ? dist.env : undefined), ...config.env },
  });
  proc.catch(() => {});

  const client = new AgentClient(sessionKey, pubsub);
  const conn = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout! as import("node:stream").Readable) as ReadableStream<Uint8Array>,
    ),
  );

  return { conn, client };
}
