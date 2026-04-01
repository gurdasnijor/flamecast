/**
 * AgentRuntime — testable seam between VO handlers and Restate.
 *
 * NO Restate imports in this file. Must be implementable without the SDK.
 * See restate.ts for the Restate implementation, test.ts for the test stub.
 *
 * Reference: docs/re-arch-unification.md Change 1
 */

import type { SessionEvent } from "@flamecast/protocol/session";

// ─── Logger ───────────────────────────────────────────────────────────────

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ─── Durable Promise ──────────────────────────────────────────────────────

export interface DurablePromise<T> {
  /** Stable ID used to resolve this promise from outside the VO. */
  id: string;
  /** Awaiting this suspends the VO at zero compute cost. */
  promise: Promise<T>;
}

// ─── AgentRuntime ─────────────────────────────────────────────────────────

export interface AgentRuntime {
  /** Session ID — the VO key. */
  readonly key: string;
  readonly log: Logger;

  // ── Durable execution ──────────────────────────────────────────────────

  /**
   * Journal a side-effecting operation.
   * On Restate replay, fn() is skipped and the journaled result returned.
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /** Durable sleep. VO suspends, zero compute consumed. */
  sleep(durationMs: number): Promise<void>;

  /**
   * Deterministic current timestamp.
   * Journaled — returns the same value on replay, never live wall clock.
   */
  now(): Promise<string>;

  // ── Durable promises ───────────────────────────────────────────────────

  /**
   * Create a durable promise that will be resolved by an external caller.
   *
   * Call pattern (must follow this ordering):
   *   1. const gen = ((await runtime.state.get('generation')) ?? 0) + 1
   *   2. runtime.state.set('generation', gen)
   *   3. const dp = runtime.createDurablePromise<T>(tag, gen)
   *   4. runtime.emit({ type: 'pause', awakeableId: dp.id, generation: gen, ... })
   *   5. const result = await dp.promise   // VO suspends here
   *
   * Maps to ctx.awakeable().
   */
  createDurablePromise<T>(tag: string, generation: number): DurablePromise<T>;

  /**
   * Resolve a pending durable promise. Validates generation to reject stale
   * resumes after cancel/steer. Throws on mismatch.
   */
  resolveDurablePromise(
    id: string,
    generation: number,
    payload: unknown,
  ): void;

  // ── State ──────────────────────────────────────────────────────────────

  /**
   * KV state scoped to this session VO.
   * set/clear are synchronous. get is async.
   */
  state: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): void;
    clear(key: string): void;
    clearAll(): void;
  };

  // ── Events ─────────────────────────────────────────────────────────────

  /**
   * Publish a SessionEvent to this session's pubsub topic.
   * Fire-and-forget.
   */
  emit(event: SessionEvent): void;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Schedule cleanup of this session's VO state after a delay.
   */
  scheduleCleanup(delayMs: number): void;
}
