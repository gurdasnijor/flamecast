/**
 * AgentSession — unified Restate Virtual Object.
 *
 * Two protocols:
 * - stdio: StdioAdapter + InProcessRuntimeHost
 * - a2a: A2AAdapter (HTTP)
 *
 * State decomposed by concern:
 * - 'agent': AgentManifest (identity, protocol). Set once.
 * - 'connection': ConnectionHandle (pid, url). Set at start.
 * - 'meta': SessionMeta (status, timestamps). Updated throughout.
 * - 'cwd': Working directory. Set at start.
 */

import * as restate from "@restatedev/restate-sdk";
import type { PromptResult, AgentStartConfig, SessionMeta, SessionHandle } from "./adapter.js";
import type { AgentRuntime } from "../runtime/types.js";
import { createRestateRuntime } from "../runtime/restate.js";
import { StdioAdapter } from "../adapters/stdio.js";
import { A2AAdapter } from "../adapters/a2a.js";
import { createRuntimeHost, type RuntimeHost, type RuntimeHostCallbacks } from "../runtime-host/index.js";
import { InProcessRuntimeHost } from "../runtime-host/local.js";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { sharedHandlers } from "./shared-handlers.js";

// External pubsub client for streaming events during prompt execution.
// Per Restate docs: https://docs.restate.dev/ai/patterns/streaming-responses
const RESTATE_URL = process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";
const pubsub = createPubsubClient({ name: "pubsub", ingressUrl: RESTATE_URL });

const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

// Module-level singleton — env-driven via FLAMECAST_RUNTIME_HOST.
// "inprocess" (default) → InProcessRuntimeHost (holds live processes in this Node process)
// "remote" → RemoteRuntimeHost (delegates to HTTP sidecar)
const runtimeHost: RuntimeHost = createRuntimeHost();

// ─── State types ─────────────────────────────────────────────────────────

interface AgentManifest {
  protocol: "stdio" | "a2a";
  name: string;
  description?: string;
  capabilities?: Record<string, unknown>;
  endpoint: string;
  args?: string[];
}

interface ConnectionHandle {
  url?: string;
  pid?: number;
  containerId?: string;
  sandboxId?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeRuntime(ctx: restate.ObjectContext): AgentRuntime {
  return createRestateRuntime(ctx, { objectName: "AgentSession" });
}

function toSessionHandle(
  sessionId: string,
  agent: AgentManifest,
  connection: ConnectionHandle,
): SessionHandle {
  return {
    sessionId,
    protocol: agent.protocol,
    agent: {
      name: agent.name,
      description: agent.description,
      capabilities: agent.capabilities,
    },
    connection,
  };
}

async function loadSession(
  runtime: AgentRuntime,
): Promise<{ agent: AgentManifest; handle: SessionHandle }> {
  const agent = await runtime.state.get<AgentManifest>("agent");
  if (!agent) throw new restate.TerminalError("No active session");
  const connection =
    (await runtime.state.get<ConnectionHandle>("connection")) ?? {};
  return { agent, handle: toSessionHandle(runtime.key, agent, connection) };
}

/**
 * Ensure a stdio agent process exists in RuntimeHost.
 * If the process died (crash, replay), re-spawn it.
 *
 * For remote mode, the server manages process lifecycle — skip the check.
 */
async function ensureStdioProcess(
  sessionId: string,
  agent: AgentManifest,
): Promise<void> {
  // Remote server manages process lifecycle
  if (!(runtimeHost instanceof InProcessRuntimeHost)) return;
  if (runtimeHost.has(sessionId)) return;

  // Re-spawn — process died or this is a replay
  const adapter = new StdioAdapter(runtimeHost);
  await adapter.start({
    agent: agent.endpoint,
    args: agent.args,
    sessionId,
    cwd: undefined, // cwd is stored separately in VO state
  });
}

// ─── Virtual Object ──────────────────────────────────────────────────────

export const AgentSession = restate.object({
  name: "AgentSession",
  handlers: {
    ...sharedHandlers,

    startSession: async (
      ctx: restate.ObjectContext,
      input: AgentStartConfig & { protocol?: "stdio" | "a2a" },
    ): Promise<SessionHandle> => {
      const runtime = makeRuntime(ctx);
      const protocol = input.protocol ?? "stdio";

      let name: string;
      let description: string | undefined;
      let capabilities: Record<string, unknown> | undefined;
      let connection: ConnectionHandle;

      if (protocol === "a2a") {
        const adapter = new A2AAdapter();
        const raw = await runtime.step("start", () => adapter.start(input));
        name = raw.agent.name;
        description = raw.agent.description;
        capabilities = raw.agent.capabilities;
        connection = { url: raw.connection.url };
      } else {
        // Wrap spawn in ctx.run — journals the agent info (name, caps).
        // On replay, ctx.run returns journaled result (process won't exist
        // but ensureStdioProcess in conversationLoop re-spawns it).
        const raw = await runtime.step("start", async () => {
          const adapter = new StdioAdapter(runtimeHost);
          const result = await adapter.start({ ...input, sessionId: runtime.key });
          return {
            name: result.agent.name,
            description: result.agent.description,
            capabilities: result.agent.capabilities,
          };
        });
        name = raw.name;
        description = raw.description;
        capabilities = raw.capabilities;
        connection = {};
      }

      const agent: AgentManifest = {
        protocol,
        name,
        description,
        capabilities,
        endpoint: input.agent,
        args: input.args,
      };

      const now = await runtime.now();
      const meta: SessionMeta = {
        sessionId: runtime.key,
        protocol,
        agent: { name, description, capabilities },
        status: "active",
        startedAt: now,
        lastUpdatedAt: now,
      };

      runtime.state.set("agent", agent);
      runtime.state.set("connection", connection);
      runtime.state.set("meta", meta);
      if (input.cwd) runtime.state.set("cwd", input.cwd);

      const handle = toSessionHandle(runtime.key, agent, connection);
      runtime.emit({ type: "session.created", meta });

      // Start the conversation loop in the background.
      // It immediately suspends waiting for the first prompt via sendPrompt.
      ctx.objectSendClient(AgentSession, ctx.key).conversationLoop();

      return handle;
    },

    /**
     * Conversation loop — single invocation for the entire session.
     *
     * Kicked off by startSession (fire-and-forget). Loops:
     *   suspend → receive prompt (via sendPrompt) → drive agent → emit result → repeat
     *
     * One Restate invocation per session. Zero compute between turns.
     */
    conversationLoop: async (
      ctx: restate.ObjectContext,
    ): Promise<PromptResult> => {
      const runtime = makeRuntime(ctx);
      const { agent, handle } = await loadSession(runtime);

      await ensureStdioProcess(handle.sessionId, agent);
      const topic = `session:${handle.sessionId}`;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Suspend and wait for the next prompt
        const { id: promptId, promise: promptPromise } =
          ctx.awakeable<{ text: string } | null>();
        runtime.state.set("pending_prompt", { awakeableId: promptId });

        const next = await promptPromise;
        runtime.state.clear("pending_prompt");

        if (!next) break; // null = conversation terminated

        const promptHandle = {
          sessionId: handle.sessionId,
          strategy: "local" as const,
          agentName: handle.agent.name,
        };

        let result: PromptResult;

        if (runtimeHost instanceof InProcessRuntimeHost) {
          // ── Inprocess path ────────────────────────────────────────
          // VO stays active during prompt — needed so permission callbacks
          // can create awakeables via ctx.
          result = await new Promise<PromptResult>((resolve) => {
            runtimeHost.prompt(promptHandle, next.text, {
              onEvent(event) {
                pubsub.publish(topic, event).catch(() => {});
              },
              async onPermission(request) {
                // Each permission gets its own awakeable — supports
                // concurrent permissions without overwriting shared state.
                const { id: awakeableId, promise } =
                  ctx.awakeable<{ optionId: string }>();

                pubsub.publish(topic, {
                  type: "permission_request",
                  requestId: request.toolCallId,
                  toolCallId: request.toolCallId,
                  title: request.title,
                  kind: request.kind,
                  options: request.options,
                  awakeableId,
                  generation: 0, // not used for direct awakeable resolution
                }).catch(() => {});

                // Frontend POSTs /resume with { awakeableId, payload }
                // which calls resolveAwakeable directly
                const response = await promise;
                return { optionId: response.optionId };
              },
              onComplete(r) {
                resolve(r as PromptResult);
              },
              onError(err) {
                resolve({
                  status: "failed",
                  error: err.message,
                  runId: handle.sessionId,
                });
              },
            });
          });
        } else {
          // ── Remote path ───────────────────────────────────────────
          // VO suspends on awakeable — zero compute while agent runs on
          // remote server. Server publishes events to pubsub directly
          // and resolves the awakeable on terminal state.
          const { id: completionId, promise: completionPromise } =
            ctx.awakeable<PromptResult>();

          const noopCallbacks: RuntimeHostCallbacks = {
            onEvent() {},
            async onPermission(request) {
              return { optionId: request.options[0]?.optionId ?? "approved" };
            },
            onComplete() {},
            onError() {},
          };

          await runtimeHost.prompt(
            promptHandle,
            next.text,
            noopCallbacks,
            completionId,
          );

          result = await completionPromise;
        }

        // Emit the result for this turn
        // Publish result via external pubsub (not ctx — non-deterministic value).
        // Don't store in VO state — the agent response changes on replay.
        pubsub.publish(topic, { type: "complete", result }).catch(() => {});
        // Loop back to top — suspend on next awakeable
      }

      return { status: "completed" };
    },

    cancelAgent: async (
      ctx: restate.ObjectContext,
    ): Promise<{ cancelled: boolean }> => {
      const runtime = makeRuntime(ctx);
      const { agent, handle } = await loadSession(runtime);

      if (agent.protocol === "a2a") {
        await runtime.step("cancel", () => new A2AAdapter().cancel(handle));
      } else {
        // Ephemeral — cancel the live process directly, not via ctx.run
        await new StdioAdapter(runtimeHost).cancel(handle);
      }

      runtime.state.clear("pending_pause");
      runtime.state.clear("pending_run");
      return { cancelled: true };
    },

    steerAgent: async (
      ctx: restate.ObjectContext,
      input: { newText: string; mode?: string; model?: string },
    ): Promise<PromptResult> => {
      const runtime = makeRuntime(ctx);
      const { agent, handle } = await loadSession(runtime);

      if (agent.protocol === "a2a") {
        await runtime.step("cancel", () => new A2AAdapter().cancel(handle));
      } else {
        await new StdioAdapter(runtimeHost).cancel(handle);
      }

      // Send the new prompt — the conversation loop will pick it up
      await ctx
        .objectClient(AgentSession, ctx.key)
        .sendPrompt({ text: input.newText });
      return { status: "completed" };
    },

    terminateSession: async (ctx: restate.ObjectContext): Promise<void> => {
      const runtime = makeRuntime(ctx);
      const agentManifest = await runtime.state.get<AgentManifest>("agent");
      if (agentManifest) {
        const connection =
          (await runtime.state.get<ConnectionHandle>("connection")) ?? {};
        const handle = toSessionHandle(runtime.key, agentManifest, connection);
        if (agentManifest.protocol === "a2a") {
          await runtime.step("close", () => new A2AAdapter().close(handle));
        } else {
          // Ephemeral — kill the live process directly
          await new StdioAdapter(runtimeHost).close(handle);
        }
      }

      const meta = await runtime.state.get<SessionMeta>("meta");
      if (meta) {
        runtime.state.set("meta", {
          ...meta,
          status: "killed" as const,
          lastUpdatedAt: await runtime.now(),
        });
      }

      runtime.emit({ type: "session.terminated" });
      runtime.scheduleCleanup(CLEANUP_DELAY_MS);
    },
  },
});
