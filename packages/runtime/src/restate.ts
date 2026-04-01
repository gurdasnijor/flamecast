/**
 * Restate implementation of AgentRuntime.
 *
 * Maps AgentRuntime methods to Restate SDK primitives:
 *   step       → ctx.run(name, fn)
 *   sleep      → ctx.sleep(ms)
 *   now        → ctx.date.toJSON()
 *   createDurablePromise → ctx.awakeable()
 *   state      → ctx.get/set/clear/clearAll
 *   emit       → ctx.objectSendClient(pubsub, topic).publish(event)
 *   scheduleCleanup → ctx.objectSendClient(vo, key, { delay }).cleanup()
 */

import * as restate from "@restatedev/restate-sdk";
import type { SessionEvent } from "@flamecast/protocol/session";
import type { AgentRuntime, DurablePromise } from "./types.js";

export interface RestateRuntimeOptions {
  /** Name of the pubsub virtual object (default: "pubsub"). */
  pubsubName?: string;
  /** Name of the agent session VO (for scheduleCleanup self-send). */
  objectName: string;
}

export function createRestateRuntime(
  ctx: restate.ObjectContext,
  options: RestateRuntimeOptions,
): AgentRuntime {
  const pubsubName = options.pubsubName ?? "pubsub";

  return {
    key: ctx.key,

    log: {
      info: (...a) => ctx.console.info(...a),
      warn: (...a) => ctx.console.warn(...a),
      error: (...a) => ctx.console.error(...a),
    },

    step: (name, fn) => ctx.run(name, fn),
    sleep: (ms) => ctx.sleep(ms),
    now: () => new Date().toISOString(),

    createDurablePromise<T>(
      tag: string,
      generation: number,
    ): DurablePromise<T> {
      const { id, promise } = ctx.awakeable<T>();
      ctx.set("pending_pause", { id, generation, tag });
      return { id, promise };
    },

    resolveDurablePromise(id, generation, payload) {
      // Note: in practice, resolveDurablePromise is called from the
      // resumeAgent shared handler which reads pending_pause directly
      // from ctx. This method exists for interface symmetry and testing.
      // The Restate impl delegates to the shared handler pattern.
      void ctx
        .get<{ id: string; generation: number }>("pending_pause")
        .then((pending) => {
          if (!pending || pending.generation !== generation) {
            throw new restate.TerminalError(
              "Stale resume — generation mismatch",
              { errorCode: 409 },
            );
          }
          ctx.resolveAwakeable(id, payload);
        });
    },

    state: {
      get: <T>(k: string) => ctx.get<T>(k),
      set: (k, v) => ctx.set(k, v),
      clear: (k) => ctx.clear(k),
      clearAll: () => ctx.clearAll(),
    },

    emit(event: SessionEvent) {
      const client = ctx.objectSendClient<{
        publish: (msg: unknown) => void;
      }>({ name: pubsubName }, `session:${ctx.key}`);
      (client as unknown as { publish: (msg: unknown) => void }).publish(
        event,
      );
    },

    scheduleCleanup(delayMs) {
      (
        ctx.objectSendClient(
          { name: options.objectName },
          ctx.key,
          { delay: delayMs },
        ) as unknown as { cleanup: () => void }
      ).cleanup();
    },
  };
}
