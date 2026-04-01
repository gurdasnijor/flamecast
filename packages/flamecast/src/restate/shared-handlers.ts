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
import type { AgentRuntime } from "../runtime/types.js";

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
  runtime: AgentRuntime,
  adapter: AgentAdapter,
  session: SessionHandle,
  result: PromptResult,
): Promise<PromptResult> {
  if (result.status === "completed") {
    runtime.state.set("lastRun", result);
    runtime.emit({ type: "complete", result });
    return result;
  }
  if (result.status === "awaiting") {
    return await handleAwaiting(ctx, runtime, adapter, session, result);
  }
  if (result.status === "failed") {
    const msg =
      typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
    throw new restate.TerminalError(`Agent run failed: ${msg}`);
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
  runtime: AgentRuntime,
  adapter: AgentAdapter,
  session: SessionHandle,
  result: PromptResult,
): Promise<PromptResult> {
  let currentResult = result;

  while (currentResult.status === "awaiting") {
    // 1. Read and increment generation BEFORE creating durable promise.
    const generation =
      ((await runtime.state.get<number>("generation")) ?? 0) + 1;
    runtime.state.set("generation", generation);

    // 2. Create durable promise synchronously (stores pending_pause state).
    const dp = runtime.createDurablePromise<unknown>("pause", generation);

    // 3. Emit pause event with the promise ID so UI can call /resume.
    runtime.emit({
      type: "pause",
      request: currentResult.awaitRequest,
      generation,
    });

    // 4. Suspend — zero compute until client POSTs /resume.
    const resumePayload = await dp.promise;

    runtime.state.clear("pending_pause");

    // 5. Capture runId before ctx.run to avoid closure over mutable variable.
    const runId = currentResult.runId!;
    currentResult = await ctx.run("resume", () =>
      adapter.resumeSync(session, runId, resumePayload),
    );
  }

  runtime.state.set("lastRun", currentResult);
  runtime.emit({ type: "complete", result: currentResult });
  return currentResult;
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
