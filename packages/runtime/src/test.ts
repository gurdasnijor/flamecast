/**
 * Test implementation of AgentRuntime.
 * Zero Restate dependency. For unit tests.
 */

import type { SessionEvent } from "@flamecast/protocol/session";
import type { AgentRuntime, DurablePromise } from "./types.js";

export interface TestRuntime extends AgentRuntime {
  /** Resolve a pending durable promise directly by ID (no generation check). */
  resolveDurablePromiseById(id: string, payload: unknown): void;
  /** All events emitted during this run. */
  events: SessionEvent[];
  /** Raw state map for assertions. */
  stateMap: Map<string, unknown>;
  /** Number of times scheduleCleanup was called. */
  cleanupCount: number;
}

export function createTestRuntime(
  sessionId = "test-session",
): TestRuntime {
  const stateMap = new Map<string, unknown>();
  const resolvers = new Map<string, (v: unknown) => void>();
  const events: SessionEvent[] = [];
  let cleanupCount = 0;
  let dpCounter = 0;

  return {
    key: sessionId,
    log: {
      info: console.info,
      warn: console.warn,
      error: console.error,
    },

    step: (_n, fn) => fn(),
    sleep: () => Promise.resolve(),
    now: () => new Date().toISOString(),

    createDurablePromise<T>(
      tag: string,
      generation: number,
    ): DurablePromise<T> {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      const id = `dp-${tag}-${++dpCounter}-gen${generation}`;
      resolvers.set(id, resolve as (v: unknown) => void);
      stateMap.set("pending_pause", { id, generation, tag });
      return { id, promise };
    },

    resolveDurablePromise(id, generation, payload) {
      const pending = stateMap.get("pending_pause") as {
        generation: number;
      } | null;
      if (!pending || pending.generation !== generation) {
        throw new Error("Stale resume — generation mismatch");
      }
      const resolve = resolvers.get(id);
      if (!resolve) throw new Error(`No pending promise with id: ${id}`);
      resolve(payload);
    },

    resolveDurablePromiseById(id, payload) {
      const resolve = resolvers.get(id);
      if (!resolve) throw new Error(`No pending promise with id: ${id}`);
      resolve(payload);
    },

    state: {
      get: <T>(k: string) =>
        Promise.resolve((stateMap.get(k) ?? null) as T | null),
      set: (k, v) => {
        stateMap.set(k, v);
      },
      clear: (k) => {
        stateMap.delete(k);
      },
      clearAll: () => {
        stateMap.clear();
      },
    },

    emit: (event) => {
      events.push(event);
    },

    scheduleCleanup: () => {
      cleanupCount++;
    },

    events,
    stateMap,
    get cleanupCount() {
      return cleanupCount;
    },
  };
}
