/**
 * AgentSession — unified Restate Virtual Object.
 *
 * Two protocols, same pattern:
 * - stdio: StdioAdapter + InProcessRuntimeHost
 * - a2a: A2AAdapter (HTTP)
 *
 * Both follow: create awakeable → kick off work → suspend → resume on completion.
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
import type { RuntimeHostCallbacks } from "@flamecast/runtime-host";
import type { PromptResultPayload } from "@flamecast/protocol/session";
import { sharedHandlers, handleResult } from "./shared-handlers.js";

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
        const adapter = new StdioAdapter(getRuntimeHost());
        const raw = await runtime.step("start", () => adapter.start(input));
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
        // Stdio: create awakeable, kick off prompt via RuntimeHost, suspend.
        const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();

        const adapter = new StdioAdapter(getRuntimeHost());
        const callbacks: RuntimeHostCallbacks = {
          onEvent(event) {
            // Publish streaming events to pubsub in real-time
            runtime.emit(event as any);
          },
          async onPermission(request) {
            // TODO: route through VO awakeable for durable permission handling.
            // For now, auto-approve first option.
            return { optionId: request.options[0]?.optionId ?? "approved" };
          },
          onComplete(result) {
            // Resolve the VO's awakeable — this resumes the handler
            ctx.resolveAwakeable(awakeableId, result);
          },
          onError(err) {
            ctx.resolveAwakeable(awakeableId, {
              status: "failed",
              error: err.message,
              runId: handle.sessionId,
            } satisfies PromptResultPayload);
          },
        };

        // Fire-and-forget — RuntimeHost drives the agent
        adapter.promptAsync(handle, input.text, callbacks);

        // Suspend until RuntimeHost calls onComplete/onError
        const result = await promise;
        return handleResult(ctx, runtime, adapter as any, handle, result);
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
        await runtime.step("cancel", () =>
          new StdioAdapter(getRuntimeHost()).cancel(handle),
        );
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
        await runtime.step("cancel", () =>
          new StdioAdapter(getRuntimeHost()).cancel(handle),
        );
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
          await runtime.step("close", () =>
            new StdioAdapter(getRuntimeHost()).close(handle),
          );
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
