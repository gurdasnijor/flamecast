/**
 * Shared VO handlers for ACP agent session orchestration.
 *
 * Defines handlers that are spread into both IbmAgentSession and
 * ZedAgentSession VOs via `...sharedHandlers`. Also exports the
 * shared `handleResult` and `handleAwaiting` functions used by
 * both VOs' `runAgent` handlers.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §5.2-5.3
 */

import * as restate from "@restatedev/restate-sdk";
import type {
  AgentAdapter,
  PromptResult,
  SessionHandle,
  SessionMeta,
  WebhookConfig,
} from "./adapter.js";
import type { SessionEvent } from "@flamecast/protocol/session";

// ─── Publish helper ───────────────────────────────────────────────────────

/**
 * Publish an event to Restate pubsub via one-way send to the pubsub VO.
 * Works from any Restate context (ObjectContext, ObjectSharedContext, etc.).
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

// ─── Result routing ───────────────────────────────────────────────────────

/**
 * Route a PromptResult to the appropriate handler based on status.
 *
 * - completed → store in state, publish complete event, return
 * - awaiting  → enter the pause→awakeable loop
 * - failed    → throw TerminalError
 * - default   → return result as-is (e.g. "cancelled")
 */
export async function handleResult(
  ctx: restate.ObjectContext,
  adapter: AgentAdapter,
  session: SessionHandle,
  result: PromptResult,
): Promise<PromptResult> {
  if (result.status === "completed") {
    ctx.set("lastRun", result);
    publish(ctx, `session:${ctx.key}`, { type: "complete", result });
    return result;
  }
  if (result.status === "awaiting") {
    return await handleAwaiting(ctx, adapter, session, result);
  }
  if (result.status === "failed") {
    throw new restate.TerminalError(`Agent run failed: ${result.error}`);
  }
  return result;
}

// ─── Pause → awakeable loop ──────────────────────────────────────────────

/**
 * Handle the pause→resume loop when an agent enters "awaiting" status.
 *
 * An agent can pause multiple times within a single logical run (e.g.,
 * multi-step approval, multiple permission requests). The handler loops
 * until a terminal state. A generation counter prevents stale resumes
 * after cancel/steer.
 *
 * Reference: SDD §5.3
 */
export async function handleAwaiting(
  ctx: restate.ObjectContext,
  adapter: AgentAdapter,
  session: SessionHandle,
  result: PromptResult,
): Promise<PromptResult> {
  let currentResult = result;

  while (currentResult.status === "awaiting") {
    // Increment generation counter — prevents stale resumes
    const generation =
      ((await ctx.get<number>("generation")) ?? 0) + 1;
    ctx.set("generation", generation);

    // Publish the pause request so clients know what's needed
    publish(ctx, `session:${ctx.key}`, {
      type: "pause",
      request: currentResult.awaitRequest,
      generation,
    });

    // Store awakeable ID so external systems can resolve it
    const { id: awakeableId, promise } = ctx.awakeable<unknown>();
    ctx.set("pending_pause", {
      awakeableId,
      runId: currentResult.runId,
      request: currentResult.awaitRequest,
      generation,
    });

    // SUSPEND — zero compute until client resumes
    const resumePayload = await promise;

    ctx.clear("pending_pause");

    // Capture values before entering ctx.run() — the closure must not
    // reference the mutable `currentResult` variable, which could differ
    // between the first execution and a replay.
    const runId = currentResult.runId!;

    // Journal the resumption
    currentResult = await ctx.run("resume", () =>
      adapter.resumeSync(session, runId, resumePayload),
    );
  }

  ctx.set("lastRun", currentResult);
  publish(ctx, `session:${ctx.key}`, {
    type: "complete",
    result: currentResult,
  });
  return currentResult;
}

// ─── Shared handlers (spread into both VOs) ──────────────────────────────

export const sharedHandlers = {
  /**
   * Resume a paused agent. Checks generation counter to prevent stale
   * resumes after cancel/steer operations.
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
  getWebhooks: restate.handlers.object.shared(
    { enableLazyState: true },
    async (ctx: restate.ObjectSharedContext) =>
      (await ctx.get<WebhookConfig[]>("webhooks")) ?? [],
  ),

  /** Clear all state — called after TTL delay for garbage collection. */
  cleanup: async (ctx: restate.ObjectContext): Promise<void> => {
    ctx.clearAll();
  },
};
