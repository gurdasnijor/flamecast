/**
 * IBM ACP Virtual Object — create + awakeable pattern.
 *
 * Thin Restate VO that delegates protocol work to IbmAcpAdapter and
 * result routing to shared-handlers. The runAgent handler uses a two-phase
 * pattern: ctx.run("create-run") journals the runId immediately, then an
 * awakeable suspends with ZERO compute until the API layer's SSE listener
 * resolves it on terminal state.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §5.2
 */

import * as restate from "@restatedev/restate-sdk";
import type {
  AgentStartConfig,
  PromptResult,
  SessionHandle,
  SessionMeta,
} from "./adapter.js";
import type { AgentRuntime } from "@flamecast/runtime";
import { createRestateRuntime } from "@flamecast/runtime/restate";
import { IbmAcpAdapter } from "./ibm-acp-adapter.js";
import { handleResult, sharedHandlers } from "./shared-handlers.js";

const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

function makeRuntime(ctx: restate.ObjectContext): AgentRuntime {
  return createRestateRuntime(ctx, { objectName: "IbmAgentSession" });
}

export const IbmAgentSession = restate.object({
  name: "IbmAgentSession",
  handlers: {
    ...sharedHandlers,

    startSession: async (
      ctx: restate.ObjectContext,
      input: AgentStartConfig,
    ): Promise<SessionHandle> => {
      const runtime = makeRuntime(ctx);
      const adapter = new IbmAcpAdapter();
      const session = await runtime.step("start", () => adapter.start(input));

      const now = runtime.now();
      const meta: SessionMeta = {
        sessionId: runtime.key,
        protocol: "ibm",
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
      const adapter = new IbmAcpAdapter();

      // Phase 1: Create run (journaled) — runId visible immediately
      const { runId } = await runtime.step("create-run", () =>
        adapter.createRun(session, input.text),
      );
      runtime.emit({ type: "run.started", runId });

      // Phase 2: Suspend on awakeable — ZERO compute until terminal
      const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
      runtime.state.set("pending_run", { awakeableId, runId });

      const result = await promise;
      runtime.state.clear("pending_run");

      return handleResult(ctx, runtime, adapter, session, result);
    },

    cancelAgent: async (
      ctx: restate.ObjectContext,
    ): Promise<{ cancelled: boolean }> => {
      const runtime = makeRuntime(ctx);
      const session = await runtime.state.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      await runtime.step("cancel", () => new IbmAcpAdapter().cancel(session));
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
      const adapter = new IbmAcpAdapter();

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

      // Re-create run (same create + awakeable pattern)
      const { runId } = await runtime.step("create-run", () =>
        adapter.createRun(session, input.newText),
      );
      runtime.emit({ type: "run.started", runId });

      const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
      runtime.state.set("pending_run", { awakeableId, runId });

      const result = await promise;
      runtime.state.clear("pending_run");

      return handleResult(ctx, runtime, adapter, session, result);
    },

    terminateSession: async (ctx: restate.ObjectContext): Promise<void> => {
      const runtime = makeRuntime(ctx);
      const session = await runtime.state.get<SessionHandle>("session");
      if (session) {
        await runtime.step("close", () =>
          new IbmAcpAdapter().close(session),
        );
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
