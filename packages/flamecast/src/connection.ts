/**
 * AcpConnection — Restate Virtual Object, keyed by connectionId.
 *
 * A durable bidirectional JSON-RPC message router.
 *
 * The VO is a pure message pipe:
 *   fromClient: write to agent stdin
 *   fromAgent:  append to log → publish to client pubsub
 *
 * The VO does NOT own ACP protocol lifecycle (initialize, session/new).
 * Those flow through the normal routing path from the client's
 * ClientSideConnection — same as any ACP transport.
 *
 * All ACP types from @agentclientprotocol/sdk — no duplication.
 */

import * as restate from "@restatedev/restate-sdk";
import type * as acp from "@agentclientprotocol/sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { createPubsubPublisher } from "@restatedev/pubsub";
import { execa, type ResultPromise } from "execa";
import { Readable, Writable } from "node:stream";
import * as acpSdk from "@agentclientprotocol/sdk";

// ─── Types ────────────────────────────────────────────────────────────────

export interface CreateInput {
  agentName: string;
  spawnConfig: SpawnConfig | null;
  cwd: string;
  mcpServers: acp.NewSessionRequest["mcpServers"];
  clientCapabilities?: acp.ClientCapabilities;
}

export interface SpawnConfig {
  type: "npx";
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

export interface LogEntry {
  seq: number;
  ts: string;
  message: acp.AnyMessage;
}

export interface GetMessagesAfterInput {
  afterSeq?: number;
}

export interface GetMessagesAfterOutput {
  messages: LogEntry[];
  lastSeq: number;
}

export interface ConnectionStatus {
  connectionId: string;
  agentName: string;
  acpSessionId: string;
  closed: boolean;
  messageCount: number;
}

// ─── Module-level process cache (ephemeral, NOT durable) ──────────────────
// Exclusive handler serializes access per key, so this is safe.

interface LiveProcess {
  stream: acp.Stream;
  proc: ResultPromise;
  epoch: number;
  bridgeAbort: AbortController;
}

const processes = new Map<string, LiveProcess>();

// ─── Pubsub publisher ────────────────────────────────────────────────────

const publish = createPubsubPublisher("pubsub");

// ─── CDN config resolution ────────────────────────────────────────────────

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

// ─── Spawn agent process → raw Stream ─────────────────────────────────────

function spawnAgentProcess(config: SpawnConfig): { stream: acp.Stream; proc: ResultPromise } {
  const proc = execa(config.cmd, config.args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cleanup: true,
    env: { ...process.env, ...config.env },
  });
  proc.catch(() => {});

  const stream = acpSdk.ndJsonStream(
    Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout! as import("node:stream").Readable) as ReadableStream<Uint8Array>,
  );

  return { stream, proc };
}

// ─── Bridge: agent stdout → VO fromAgent handler ──────────────────────────

function getIngressUrl(): string {
  return process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";
}

function startBridge(
  stream: acp.Stream,
  connectionId: string,
  signal: AbortSignal,
): void {
  const ingress = restateClients.connect({ url: getIngressUrl() });
  const reader = stream.readable.getReader();

  (async () => {
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        await ingress.objectClient(AcpConnection, connectionId).fromAgent(value);
      }
    } catch (err) {
      if (!signal.aborted) {
        console.error(`[bridge] error for ${connectionId}:`, err);
      }
    } finally {
      reader.releaseLock();
      // Evict dead process from cache
      processes.delete(connectionId);
    }
  })();
}

// ─── Write to agent stdin ─────────────────────────────────────────────────

async function writeToAgent(connectionId: string, message: acp.AnyMessage): Promise<void> {
  const live = processes.get(connectionId);
  if (!live) throw new restate.TerminalError("No live agent process — connection may need to be recreated");
  const writer = live.stream.writable.getWriter();
  try {
    await writer.write(message);
  } finally {
    writer.releaseLock();
  }
}

// ─── Ensure agent process exists ──────────────────────────────────────────
// Spawns process and starts bridge if not cached.
// Does NOT send any ACP messages — the client's ClientSideConnection
// owns initialize/session/new through normal routing.

async function ensureAgent(ctx: restate.ObjectContext): Promise<LiveProcess> {
  const cached = processes.get(ctx.key);
  if (cached) return cached;

  const config = await ctx.get<SpawnConfig>("spawnConfig");
  if (!config) throw new restate.TerminalError("No spawn config — call create first");

  const { stream, proc } = spawnAgentProcess(config);

  const epoch = ((await ctx.get<number>("epoch")) ?? 0) + 1;
  ctx.set("epoch", epoch);

  // Evict from cache on process exit
  proc.then(() => processes.delete(ctx.key)).catch(() => processes.delete(ctx.key));

  // Start bridge: agent stdout → VO via Restate ingress
  const bridgeAbort = new AbortController();
  startBridge(stream, ctx.key, bridgeAbort.signal);

  const live: LiveProcess = { stream, proc, epoch, bridgeAbort };
  processes.set(ctx.key, live);

  return live;
}

// ─── Append to message log + publish ──────────────────────────────────────

async function appendAndPublish(
  ctx: restate.ObjectContext,
  message: acp.AnyMessage,
): Promise<LogEntry> {
  const messages = (await ctx.get<LogEntry[]>("clientMessages")) ?? [];
  const seq = (await ctx.get<number>("clientNextSeq")) ?? 0;
  const ts = await ctx.date.toJSON();
  const entry: LogEntry = { seq, ts, message };
  messages.push(entry);
  ctx.set("clientMessages", messages);
  ctx.set("clientNextSeq", seq + 1);
  publish(ctx, ctx.key, entry);
  return entry;
}

// ─── Virtual Object ───────────────────────────────────────────────────────

export const AcpConnection = restate.object({
  name: "AcpConnection",
  handlers: {
    /**
     * Create a durable connection. Spawns the downstream agent process
     * and starts the bridge. Does NOT send ACP initialize or session/new —
     * those come from the client through normal fromClient/fromAgent routing.
     *
     * After create returns, the caller should open a durable stream and
     * use a standard ClientSideConnection to drive the ACP lifecycle.
     */
    create: restate.handlers.object.exclusive(
      async (ctx: restate.ObjectContext, input: CreateInput): Promise<{ connectionId: string }> => {
        if (await ctx.get<string>("agentName")) {
          throw new restate.TerminalError("Connection already exists");
        }

        ctx.set("agentName", input.agentName);
        ctx.set("cwd", input.cwd);
        ctx.set("mcpServers", input.mcpServers);
        ctx.set("clientCapabilities", input.clientCapabilities ?? {});
        ctx.set("clientMessages", []);
        ctx.set("clientNextSeq", 0);
        ctx.set("epoch", 0);
        ctx.set("closed", false);

        const spawnConfig = input.spawnConfig
          ?? await ctx.run("resolve-config", () => resolveSpawnConfig(input.agentName));
        ctx.set("spawnConfig", spawnConfig);

        // Spawn process + start bridge. No ACP messages sent.
        await ensureAgent(ctx);

        return { connectionId: ctx.key };
      },
    ),

    /**
     * Route a client message to the downstream agent.
     * Called by the durable stream writable (POST to ingress).
     *
     * All ACP lifecycle (initialize, session/new, prompt, cancel) flows
     * through here — the VO does not distinguish them. It just routes.
     *
     * Exclusive handler: one message at a time per connection (single-writer).
     */
    fromClient: restate.handlers.object.exclusive(
      async (ctx: restate.ObjectContext, message: acp.AnyMessage): Promise<void> => {
        if (await ctx.get<boolean>("closed")) {
          throw new restate.TerminalError("Connection is closed");
        }

        await ensureAgent(ctx);
        await writeToAgent(ctx.key, message);
      },
    ),

    /**
     * Route an agent message to the upstream client.
     * Called by the bridge (agent stdout → Restate ingress → this handler).
     *
     * Minimal protocol awareness:
     *   - captures sessionId from session/new responses (for status)
     *
     * Exclusive handler: serializes writes to the message log.
     */
    fromAgent: restate.handlers.object.exclusive(
      async (ctx: restate.ObjectContext, message: acp.AnyMessage): Promise<void> => {
        // Capture sessionId from session/new response (minimal protocol awareness)
        const msg = message as Record<string, unknown>;
        if ("id" in msg && "result" in msg && !("method" in msg)) {
          const result = msg.result as Record<string, unknown> | null;
          if (result && "sessionId" in result && typeof result.sessionId === "string") {
            ctx.set("acpSessionId", result.sessionId);
          }
        }

        await appendAndPublish(ctx, message);
      },
    ),

    /**
     * Poll message log by offset. Shared — does not block routing.
     */
    getMessagesAfter: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext, input: GetMessagesAfterInput): Promise<GetMessagesAfterOutput> => {
        const messages = (await ctx.get<LogEntry[]>("clientMessages")) ?? [];
        const afterSeq = input.afterSeq ?? -1;
        const filtered = messages.filter((m) => m.seq > afterSeq);
        const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : -1;
        return { messages: filtered, lastSeq };
      },
    ),

    /**
     * Read-only connection status.
     */
    getStatus: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<ConnectionStatus> => {
        const messages = (await ctx.get<LogEntry[]>("clientMessages")) ?? [];
        return {
          connectionId: ctx.key,
          agentName: (await ctx.get<string>("agentName")) ?? "",
          acpSessionId: (await ctx.get<string>("acpSessionId")) ?? "",
          closed: (await ctx.get<boolean>("closed")) ?? false,
          messageCount: messages.length,
        };
      },
    ),

    /**
     * Close the connection. Kill downstream process.
     */
    close: restate.handlers.object.exclusive(
      async (ctx: restate.ObjectContext): Promise<void> => {
        ctx.set("closed", true);
        const live = processes.get(ctx.key);
        if (live) {
          live.bridgeAbort.abort();
          live.proc.kill();
          processes.delete(ctx.key);
        }
      },
    ),
  },
});
