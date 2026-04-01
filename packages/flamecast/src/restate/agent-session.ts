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
import { InProcessRuntimeHost } from "../runtime-host/local.js";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { sharedHandlers } from "./shared-handlers.js";

// External pubsub client for streaming events during prompt execution.
// Per Restate docs: https://docs.restate.dev/ai/patterns/streaming-responses
const RESTATE_URL = process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";
const pubsub = createPubsubClient({ name: "pubsub", ingressUrl: RESTATE_URL });

const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

// Singleton — holds live agent processes across VO handler invocations.
let runtimeHost: InProcessRuntimeHost | null = null;
function getRuntimeHost(): InProcessRuntimeHost {
  if (!runtimeHost) runtimeHost = new InProcessRuntimeHost();
  return runtimeHost;
}

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
 */
async function ensureStdioProcess(
  sessionId: string,
  agent: AgentManifest,
): Promise<void> {
  const host = getRuntimeHost();
  if (host.has(sessionId)) return;

  // Re-spawn — process died or this is a replay
  const adapter = new StdioAdapter(host);
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
        // Spawn outside ctx.run() — live process can't be journaled.
        // We journal ONLY the deterministic agent identity (name, endpoint),
        // NOT the pid (which changes on every spawn/replay).
        // Spawn is ephemeral — don't use its output for journaled state.
        // Agent identity comes from the deterministic input config.
        const adapter = new StdioAdapter(getRuntimeHost());
        await adapter.start({ ...input, sessionId: runtime.key });
        name = input.agent.split("/").pop() ?? "agent";
        description = undefined;
        capabilities = undefined;
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

      const now = runtime.now();
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

        // Drive the agent with this turn's text
        const result = await new Promise<PromptResult>((resolve) => {
          getRuntimeHost().prompt(
            {
              sessionId: handle.sessionId,
              strategy: "local",
              agentName: handle.agent.name,
            },
            next.text,
            {
              onEvent(event) {
                pubsub.publish(topic, event).catch(() => {});
              },
              async onPermission(request) {
                const generation =
                  ((await runtime.state.get<number>("generation")) ?? 0) + 1;
                runtime.state.set("generation", generation);

                const dp = runtime.createDurablePromise<{ optionId: string }>(
                  "permission",
                  generation,
                );

                pubsub.publish(topic, {
                  type: "permission_request",
                  requestId: request.toolCallId,
                  toolCallId: request.toolCallId,
                  title: request.title,
                  kind: request.kind,
                  options: request.options,
                  awakeableId: dp.id,
                  generation,
                }).catch(() => {});

                const response = await dp.promise;
                runtime.state.clear("pending_pause");
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
            },
          );
        });

        // Emit the result for this turn
        runtime.state.set("lastRun", result);
        runtime.emit({ type: "complete", result });
        // Loop back to top — suspend on next awakeable
      }

      // Conversation terminated (null sent via sendPrompt)
      const lastRun = await runtime.state.get<PromptResult>("lastRun");
      return lastRun ?? { status: "completed" };
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
        await new StdioAdapter(getRuntimeHost()).cancel(handle);
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
        await new StdioAdapter(getRuntimeHost()).cancel(handle);
      }

      // Send the new prompt — the conversation loop will pick it up
      return ctx
        .objectClient(AgentSession, ctx.key)
        .sendPrompt({ text: input.newText }) as unknown as Promise<PromptResult>;
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
          await new StdioAdapter(getRuntimeHost()).close(handle);
        }
      }

      const meta = await runtime.state.get<SessionMeta>("meta");
      if (meta) {
        runtime.state.set("meta", {
          ...meta,
          status: "killed" as const,
          lastUpdatedAt: runtime.now(),
        });
      }

      runtime.emit({ type: "session.terminated" });
      runtime.scheduleCleanup(CLEANUP_DELAY_MS);
    },
  },
});
