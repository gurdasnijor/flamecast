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
import type { AgentRuntime } from "@flamecast/runtime";
import { createRestateRuntime } from "@flamecast/runtime/restate";
import { StdioAdapter } from "@flamecast/adapters/stdio";
import { A2AAdapter } from "@flamecast/adapters/a2a";
import { InProcessRuntimeHost } from "@flamecast/runtime-host/local";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { sharedHandlers, handleResult } from "./shared-handlers.js";

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
        // Spawn outside ctx.run() — live process can't be journaled
        const adapter = new StdioAdapter(getRuntimeHost());
        const raw = await adapter.start({ ...input, sessionId: runtime.key });
        name = raw.agent.name;
        description = raw.agent.description;
        capabilities = raw.agent.capabilities;
        connection = { pid: raw.connection.pid };
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
      return handle;
    },

    runAgent: async (
      ctx: restate.ObjectContext,
      input: { text: string },
    ): Promise<PromptResult> => {
      const runtime = makeRuntime(ctx);
      const { agent, handle } = await loadSession(runtime);

      if (agent.protocol === "a2a") {
        const adapter = new A2AAdapter();
        const { runId } = await runtime.step("create-run", () =>
          adapter.createRun(handle, input.text),
        );
        runtime.emit({ type: "run.started", runId });

        const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
        runtime.state.set("pending_run", { awakeableId, runId });
        const result = await promise;
        runtime.state.clear("pending_run");

        return handleResult(ctx, runtime, adapter as any, handle, result);
      } else {
        // Ensure process exists (may have died or this is a replay)
        await ensureStdioProcess(handle.sessionId, agent);

        // Handler stays alive while agent works. Streaming events
        // publish via external pubsub client (not ctx).
        const topic = `session:${handle.sessionId}`;
        const result = await new Promise<PromptResult>((resolve) => {
          getRuntimeHost().prompt(
            {
              sessionId: handle.sessionId,
              strategy: "local",
              agentName: handle.agent.name,
            },
            input.text,
            {
              onEvent(event) {
                pubsub.publish(topic, event).catch(() => {});
              },
              async onPermission(request) {
                // TODO: durable permission handling
                return { optionId: request.options[0]?.optionId ?? "approved" };
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

        // Final result — ctx is still alive, runtime.emit works
        runtime.state.set("lastRun", result);
        runtime.emit({ type: "complete", result });
        return result;
      }
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

      return ctx
        .objectClient(AgentSession, ctx.key)
        .runAgent({ text: input.newText });
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
