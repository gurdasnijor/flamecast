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
import { IbmAcpAdapter } from "./ibm-acp-adapter.js";
import { handleResult, publish, sharedHandlers } from "./shared-handlers.js";

// ─── Virtual Object ──────────────────────────────────────────────────────────

export const IbmAgentSession = restate.object({
  name: "IbmAgentSession",
  handlers: {
    ...sharedHandlers,

    /**
     * Start a new IBM ACP session.
     * Calls adapter.start() to verify the agent exists, then stores
     * SessionHandle and SessionMeta in VO state.
     */
    startSession: async (
      ctx: restate.ObjectContext,
      input: AgentStartConfig,
    ): Promise<SessionHandle> => {
      const adapter = new IbmAcpAdapter();
      const session = await ctx.run("start", () => adapter.start(input));

      const now = new Date().toISOString();
      const meta: SessionMeta = {
        sessionId: ctx.key,
        protocol: "ibm",
        agent: session.agent,
        status: "active",
        startedAt: now,
        lastUpdatedAt: now,
      };
      ctx.set("session", session);
      ctx.set("meta", meta);

      publish(ctx, `session:${ctx.key}`, { type: "session.created", meta });
      return session;
    },

    /**
     * Run the agent — create + awakeable pattern.
     *
     * Phase 1: ctx.run("create-run") journals runId — visible immediately.
     * Phase 2: awakeable() suspends — ZERO compute until terminal.
     *
     * The API layer SSE listener resolves this awakeable when the IBM ACP
     * agent reaches a terminal state (completed, awaiting, failed).
     */
    runAgent: async (
      ctx: restate.ObjectContext,
      input: { text: string },
    ): Promise<PromptResult> => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new IbmAcpAdapter();

      // Phase 1: Create run (journaled) — runId visible immediately
      const { runId } = await ctx.run("create-run", () =>
        adapter.createRun(session, input.text),
      );

      // Publish immediately — clients subscribe to agent SSE by runId
      publish(ctx, `session:${ctx.key}`, { type: "run.started", runId });

      // Phase 2: Suspend on awakeable — ZERO compute until terminal
      const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
      ctx.set("pending_run", { awakeableId, runId });

      const result = await promise;
      ctx.clear("pending_run");

      return handleResult(ctx, adapter, session, result);
    },

    /**
     * Cancel the current agent run.
     */
    cancelAgent: async (
      ctx: restate.ObjectContext,
    ): Promise<{ cancelled: boolean }> => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      await ctx.run("cancel", () => new IbmAcpAdapter().cancel(session));
      ctx.clear("pending_pause");
      ctx.clear("pending_run");
      return { cancelled: true };
    },

    /**
     * Steer the agent — cancel -> config -> re-prompt.
     * Each step is a separate ctx.run() for journaling.
     */
    steerAgent: async (
      ctx: restate.ObjectContext,
      input: { newText: string; mode?: string; model?: string },
    ): Promise<PromptResult> => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new IbmAcpAdapter();

      await ctx.run("cancel", () => adapter.cancel(session));
      if (input.mode) {
        await ctx.run("set-mode", () =>
          adapter.setConfigOption(session, "mode", input.mode!),
        );
      }
      if (input.model) {
        await ctx.run("set-model", () =>
          adapter.setConfigOption(session, "model", input.model!),
        );
      }

      // Re-create run (same create + awakeable pattern)
      const { runId } = await ctx.run("create-run", () =>
        adapter.createRun(session, input.newText),
      );
      publish(ctx, `session:${ctx.key}`, { type: "run.started", runId });

      const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
      ctx.set("pending_run", { awakeableId, runId });

      const result = await promise;
      ctx.clear("pending_run");

      return handleResult(ctx, adapter, session, result);
    },

    /**
     * Terminate the session. Closes the adapter, updates meta, and
     * schedules state cleanup after 7 days.
     */
    terminateSession: async (ctx: restate.ObjectContext): Promise<void> => {
      const session = await ctx.get<SessionHandle>("session");
      if (session) {
        await ctx.run("close", () => new IbmAcpAdapter().close(session));
      }

      // Update meta to terminal status
      const meta = await ctx.get<SessionMeta>("meta");
      if (meta) {
        ctx.set("meta", {
          ...meta,
          status: "killed" as const,
          lastUpdatedAt: new Date().toISOString(),
        });
      }

      publish(ctx, `session:${ctx.key}`, { type: "session.terminated" });

      // Schedule cleanup after 7 days
      ctx
        .objectSendClient(IbmAgentSession, ctx.key, {
          delay: 7 * 24 * 60 * 60 * 1000,
        })
        .cleanup();
    },
  },
});
