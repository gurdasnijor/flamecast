/**
 * AgentSession — unified Restate Virtual Object for all ACP agents.
 *
 * Replaces ZedAgentSession + IbmAgentSession. Protocol-selected adapter:
 * - stdio: StdioAdapter + InProcessRuntimeHost (local Zed ACP agents)
 * - a2a: A2AAdapter (HTTP A2A agents — LangGraph, CrewAI, ADK, etc.)
 *
 * For stdio agents, promptSync runs OUTSIDE ctx.run() so the FlamecastClient's
 * permission/streaming callbacks can access Restate context (awakeables, pubsub).
 * This is the same ephemeral prompt + durable awakeables pattern from the old
 * ZedAgentSession, preserved here.
 *
 * For a2a agents, the two-phase create + awakeable pattern is used (same as
 * old IbmAgentSession). RuntimeHost resolves the awakeable on terminal state.
 *
 * Reference: docs/re-arch-unification.md Change 4
 */

import * as restate from "@restatedev/restate-sdk";
import type { SessionHandle, PromptResult, AgentStartConfig, SessionMeta } from "./adapter.js";
import type { SessionEvent } from "@flamecast/protocol/session";
import type { AgentRuntime } from "@flamecast/runtime";
import { createRestateRuntime } from "@flamecast/runtime/restate";
import { StdioAdapter } from "@flamecast/adapters/stdio";
import { A2AAdapter } from "@flamecast/adapters/a2a";
import { InProcessRuntimeHost } from "@flamecast/runtime-host/local";
import { ZedAcpAdapter } from "./zed-acp-adapter.js";
import { sharedHandlers, publish, handleResult } from "./shared-handlers.js";

const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

// Singleton RuntimeHost — holds all live agent processes in-process.
// Survives across VO handler invocations (processes can't survive suspension,
// but they persist in the Node process between handler calls).
let runtimeHostInstance: InProcessRuntimeHost | null = null;
function getRuntimeHost(): InProcessRuntimeHost {
  if (!runtimeHostInstance) {
    runtimeHostInstance = new InProcessRuntimeHost();
  }
  return runtimeHostInstance;
}

function makeRuntime(ctx: restate.ObjectContext): AgentRuntime {
  return createRestateRuntime(ctx, { objectName: "AgentSession" });
}

/**
 * Create a permission handler for stdio agents.
 * Uses Restate awakeables + pubsub — same pattern as before.
 */
function createPermissionHandler(runtime: AgentRuntime) {
  return async (
    params: import("@agentclientprotocol/sdk").RequestPermissionRequest,
  ) => {
    const generation =
      ((await runtime.state.get<number>("generation")) ?? 0) + 1;
    runtime.state.set("generation", generation);

    const permissionRequest = {
      requestId: params.toolCall.toolCallId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "Permission required",
      kind: params.toolCall.kind ?? undefined,
      options: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
    };

    const dp = runtime.createDurablePromise<{ optionId: string }>(
      "permission",
      generation,
    );

    runtime.emit({
      type: "permission_request",
      ...permissionRequest,
      awakeableId: dp.id,
      generation,
    });

    const response = await dp.promise;
    runtime.state.clear("pending_pause");

    return {
      outcome: { outcome: "selected" as const, optionId: response.optionId },
    };
  };
}

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

      let session: SessionHandle;
      if (protocol === "a2a") {
        const adapter = new A2AAdapter();
        const a2aSession = await runtime.step("start", () => adapter.start(input));
        session = {
          ...a2aSession,
          protocol: "ibm" as const,
        };
      } else {
        const adapter = new ZedAcpAdapter();
        session = await runtime.step("start", () => adapter.start(input));
      }

      const now = runtime.now();
      const meta: SessionMeta = {
        sessionId: runtime.key,
        protocol: session.protocol,
        agent: session.agent,
        status: "active",
        startedAt: now,
        lastUpdatedAt: now,
      };
      runtime.state.set("session", session);
      runtime.state.set("meta", meta);
      if (input.cwd) runtime.state.set("cwd", input.cwd);

      runtime.emit({ type: "session.created", meta });
      return session;
    },

    runAgent: async (
      ctx: restate.ObjectContext,
      input: { text: string },
    ): Promise<PromptResult> => {
      const runtime = makeRuntime(ctx);
      const session = await runtime.state.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");

      if (session.protocol === "ibm" || session.connection.url) {
        // A2A / IBM two-phase pattern: journal runId → suspend on awakeable
        const { IbmAcpAdapter } = await import("./ibm-acp-adapter.js");
        const adapter = new IbmAcpAdapter();

        const { runId } = await runtime.step("create-run", () =>
          adapter.createRun(session, input.text),
        );
        runtime.emit({ type: "run.started", runId });

        const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
        runtime.state.set("pending_run", { awakeableId, runId });

        const result = await promise;
        runtime.state.clear("pending_run");

        return handleResult(ctx, runtime, adapter, session, result);
      } else {
        // Stdio: ephemeral prompt + durable awakeables (existing pattern)
        const adapter = new ZedAcpAdapter();

        adapter.setPermissionHandler(session, createPermissionHandler(runtime));
        adapter.setPublishSink(session, (event) => {
          runtime.emit(event as SessionEvent);
        });

        const result = await adapter.promptSync(session, input.text);

        adapter.setPermissionHandler(session, null);
        adapter.setPublishSink(session, null);

        return handleResult(ctx, runtime, adapter, session, result);
      }
    },

    cancelAgent: async (
      ctx: restate.ObjectContext,
    ): Promise<{ cancelled: boolean }> => {
      const runtime = makeRuntime(ctx);
      const session = await runtime.state.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");

      if (session.protocol === "ibm" || session.connection.url) {
        const { IbmAcpAdapter } = await import("./ibm-acp-adapter.js");
        await runtime.step("cancel", () =>
          new IbmAcpAdapter().cancel(session),
        );
      } else {
        await runtime.step("cancel", () =>
          new ZedAcpAdapter().cancel(session),
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
      const session = await runtime.state.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");

      const isHttp = session.protocol === "ibm" || !!session.connection.url;
      const adapter = isHttp
        ? new (await import("./ibm-acp-adapter.js")).IbmAcpAdapter()
        : new ZedAcpAdapter();

      await runtime.step("cancel", () => adapter.cancel(session));
      if (input.mode) {
        await runtime.step("set-mode", () =>
          adapter.setConfigOption(session, "mode", input.mode!),
        );
      }
      if (input.model) {
        await runtime.step("set-model", () =>
          adapter.setConfigOption(session, "model", input.model!),
        );
      }

      // Re-run via self-call
      return ctx
        .objectClient(AgentSession, ctx.key)
        .runAgent({ text: input.newText });
    },

    terminateSession: async (ctx: restate.ObjectContext): Promise<void> => {
      const runtime = makeRuntime(ctx);
      const session = await runtime.state.get<SessionHandle>("session");
      if (session) {
        const isHttp = session.protocol === "ibm" || !!session.connection.url;
        if (isHttp) {
          const { IbmAcpAdapter } = await import("./ibm-acp-adapter.js");
          await runtime.step("close", () =>
            new IbmAcpAdapter().close(session),
          );
        } else {
          await runtime.step("close", () =>
            new ZedAcpAdapter().close(session),
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
