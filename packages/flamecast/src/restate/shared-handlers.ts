/**
 * Shared VO handlers for AgentSession.
 *
 * Spread into AgentSession via `...sharedHandlers`.
 */

import * as restate from "@restatedev/restate-sdk";
import type { SessionMeta } from "./adapter.js";
import type { SessionEvent } from "@flamecast/protocol/session";

// ─── Publish helper (still needed for shared handlers that lack AgentRuntime) ─

/**
 * Publish an event to Restate pubsub via one-way send to the pubsub VO.
 * Used by shared handlers running in ObjectSharedContext (no AgentRuntime).
 * VO handlers should use runtime.emit() instead.
 */
export function publish(
  ctx: restate.Context,
  topic: string,
  event: SessionEvent,
): void {
  const client = ctx.objectSendClient<{ publish: (msg: unknown) => void }>(
    { name: "pubsub" },
    topic,
  );
  (client as unknown as { publish: (msg: unknown) => void }).publish(event);
}





// ─── Shared handlers (spread into both VOs) ──────────────────────────────

export const sharedHandlers = {
  /**
   * Resume a paused agent. Checks generation counter to prevent stale
   * resumes after cancel/steer operations. Emits permission_responded
   * so RuntimeHost can unblock its SDK callback via SSE.
   */
  resumeAgent: restate.handlers.object.shared(
    { enableLazyState: true },
    async (
      ctx: restate.ObjectSharedContext,
      input: { awakeableId: string; payload: unknown; generation: number },
    ) => {
      const pending = await ctx.get<{ generation: number }>("pending_pause");
      if (!pending || pending.generation !== input.generation) {
        throw new restate.TerminalError(
          "Stale resume — pause was cancelled or superseded",
        );
      }
      ctx.resolveAwakeable(input.awakeableId, input.payload);

      // Emit so RuntimeHost (listening on SSE) can unblock its SDK callback
      publish(ctx, `session:${ctx.key}`, {
        type: "permission_responded",
        awakeableId: input.awakeableId,
        decision: input.payload,
      } as SessionEvent);
    },
  ),

  /**
   * Send a prompt to a running conversation.
   * Resolves the "awaiting next prompt" awakeable in the runAgent loop.
   * This is a shared handler so it runs concurrently with the suspended
   * exclusive runAgent handler.
   */
  sendPrompt: restate.handlers.object.shared(
    { enableLazyState: true },
    async (
      ctx: restate.ObjectSharedContext,
      input: { text: string },
    ) => {
      const pending = await ctx.get<{ awakeableId: string }>("pending_prompt");
      if (!pending) {
        throw new restate.TerminalError(
          "No pending prompt — session may not be running or is mid-turn",
        );
      }
      ctx.resolveAwakeable(pending.awakeableId, { text: input.text });
    },
  ),

  /** Return session metadata (includes cwd if set). */
  getStatus: restate.handlers.object.shared(
    { enableLazyState: true },
    async (ctx: restate.ObjectSharedContext) => {
      const meta = await ctx.get<SessionMeta>("meta");
      if (!meta) return null;
      const cwd = await ctx.get<string>("cwd");
      return { ...meta, ...(cwd ? { cwd } : {}) };
    },
  ),

  /** Return webhook configurations. */

  /** Clear all state — called after TTL delay for garbage collection. */
  cleanup: async (ctx: restate.ObjectContext): Promise<void> => {
    ctx.clearAll();
  },
};
