/**
 * ZedAgentSession — Restate Virtual Object for Zed ACP agents.
 *
 * promptSync runs OUTSIDE ctx.run() so the FlamecastClient's
 * requestPermission() callback can create awakeables and publish
 * to pubsub. The prompt itself is ephemeral (not journaled); only
 * the final result + permission awakeables are durable.
 *
 * Token streaming for Zed is via session-host WebSocket (client-direct),
 * NOT through the VO.
 *
 * Needs increased Restate inactivity timeout — set at service config level
 * (restate.toml or deployment registration), not in code.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §5.2
 */

import * as restate from "@restatedev/restate-sdk";
import type {
  SessionHandle,
  PromptResult,
  AgentStartConfig,
  SessionMeta,
} from "./adapter.js";
import type { SessionEvent } from "@flamecast/protocol/session";
import { ZedAcpAdapter } from "./zed-acp-adapter.js";
import { sharedHandlers, publish, handleResult } from "./shared-handlers.js";

/**
 * Create a permission handler that uses Restate awakeables + pubsub.
 * Follows the same generation counter pattern as handleAwaiting in
 * shared-handlers.ts.
 */
function createPermissionHandler(ctx: restate.ObjectContext) {
  return async (params: import("@agentclientprotocol/sdk").RequestPermissionRequest) => {
    const generation = ((await ctx.get<number>("generation")) ?? 0) + 1;
    ctx.set("generation", generation);

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

    const { id: awakeableId, promise } = ctx.awakeable<{ optionId: string }>();
    ctx.set("pending_pause", {
      awakeableId,
      generation,
      request: permissionRequest,
    });

    const event: SessionEvent = {
      type: "permission_request",
      ...permissionRequest,
      awakeableId,
      generation,
    };
    publish(ctx, `session:${ctx.key}`, event);

    const response = await promise;
    ctx.clear("pending_pause");

    return {
      outcome: { outcome: "selected" as const, optionId: response.optionId },
    };
  };
}

export const ZedAgentSession = restate.object({
  name: "ZedAgentSession",
  handlers: {
    ...sharedHandlers,

    /**
     * Start a new Zed ACP session.
     * Spawns the agent process, sends initialize + session/new.
     * Stores SessionHandle in VO state.
     */
    startSession: async (
      ctx: restate.ObjectContext,
      input: AgentStartConfig,
    ): Promise<SessionHandle> => {
      const adapter = new ZedAcpAdapter();
      const session = await ctx.run("start", () => adapter.start(input));

      const now = new Date().toISOString();
      const meta: SessionMeta = {
        sessionId: ctx.key,
        protocol: "zed",
        agent: session.agent,
        status: "active",
        startedAt: now,
        lastUpdatedAt: now,
      };
      ctx.set("session", session);
      ctx.set("meta", meta);
      ctx.set("cwd", input.cwd);

      publish(ctx, `session:${ctx.key}`, { type: "session.created", meta });
      return session;
    },

    /**
     * Run the agent — ephemeral prompt with durable permission awakeables.
     *
     * promptSync runs OUTSIDE ctx.run() so permission callbacks can create
     * awakeables and publish to pubsub. The prompt is ephemeral; only the
     * final result is journaled via handleResult.
     */
    runAgent: async (
      ctx: restate.ObjectContext,
      input: { text: string },
    ): Promise<PromptResult> => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new ZedAcpAdapter();

      // Inject permission handler + publish sink for real-time streaming
      adapter.setPermissionHandler(session, createPermissionHandler(ctx));
      adapter.setPublishSink(session, (event) => {
        publish(ctx, `session:${ctx.key}`, event as SessionEvent);
      });

      // Run prompt OUTSIDE ctx.run() — ephemeral, not journaled.
      // Permission callbacks inside will create awakeables (durable).
      // Streaming events publish to pubsub in real-time via the sink.
      const result = await adapter.promptSync(session, input.text);

      // Clean up handlers
      adapter.setPermissionHandler(session, null);
      adapter.setPublishSink(session, null);

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
      await ctx.run("cancel", () => new ZedAcpAdapter().cancel(session));
      ctx.clear("pending_pause");
      return { cancelled: true };
    },

    /**
     * Steer the agent — cancel, optionally reconfigure, then re-prompt.
     * Each step is a separate ctx.run() for journaling.
     */
    steerAgent: async (
      ctx: restate.ObjectContext,
      input: { newText: string; mode?: string; model?: string },
    ): Promise<PromptResult> => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new ZedAcpAdapter();

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

      // Re-prompt with permission handler + streaming (same ephemeral pattern)
      adapter.setPermissionHandler(session, createPermissionHandler(ctx));
      adapter.setPublishSink(session, (event) => {
        publish(ctx, `session:${ctx.key}`, event as SessionEvent);
      });
      const result = await adapter.promptSync(session, input.newText);
      adapter.setPermissionHandler(session, null);
      adapter.setPublishSink(session, null);

      return handleResult(ctx, adapter, session, result);
    },

    /**
     * Terminate the session. Kill process, cleanup state after delay.
     */
    terminateSession: async (ctx: restate.ObjectContext): Promise<void> => {
      const session = await ctx.get<SessionHandle>("session");
      if (session) {
        await ctx.run("close", () => new ZedAcpAdapter().close(session));
      }

      // Update meta to killed status
      const meta = await ctx.get<SessionMeta>("meta");
      if (meta) {
        ctx.set("meta", {
          ...meta,
          status: "killed" as const,
          lastUpdatedAt: new Date().toISOString(),
        });
      }

      publish(ctx, `session:${ctx.key}`, { type: "session.terminated" });

      // Schedule state cleanup after 7 days
      ctx
        .objectSendClient(ZedAgentSession, ctx.key, {
          delay: 7 * 24 * 60 * 60 * 1000,
        })
        .cleanup();
    },
  },
});
