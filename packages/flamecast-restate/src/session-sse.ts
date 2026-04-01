/**
 * Client SSE endpoint for ACP session events.
 *
 * Single SSE stream per session backed by Restate pubsub. Multiplexes:
 * - Durable VO events: run.started, pause, complete, session lifecycle
 * - Token events: message.part (IBM only, forwarded by watchAgentRun)
 *
 * Supports Last-Event-ID for reconnection replay. Durable events replay;
 * ephemeral token events don't (message.completed has full content).
 *
 * Reference: docs/sdd-durable-acp-bridge.md §5.5
 */

import { createPubsubClient } from "@restatedev/pubsub-client";

export interface SessionSSEOptions {
  /** Restate ingress URL (default: http://localhost:18080) */
  restateUrl?: string;
  /** Name of the pubsub virtual object (default: "pubsub") */
  pubsubName?: string;
}

/**
 * Create an SSE ReadableStream for a session's event topic.
 *
 * The stream emits all events published to `session:{sessionId}` via
 * Restate pubsub. Connect with Last-Event-ID to resume from a specific
 * offset after reconnection.
 *
 * @example
 * ```ts
 * // In a Hono route handler:
 * app.get("/sessions/:id/events/stream", (c) => {
 *   const sessionId = c.req.param("id");
 *   const lastEventId = c.req.header("Last-Event-ID");
 *   const stream = createSessionSSEStream(sessionId, { lastEventId });
 *   return new Response(stream, {
 *     headers: {
 *       "Content-Type": "text/event-stream",
 *       "Cache-Control": "no-cache",
 *       "Connection": "keep-alive",
 *     },
 *   });
 * });
 * ```
 */
export function createSessionSSEStream(
  sessionId: string,
  options?: SessionSSEOptions & {
    lastEventId?: string;
    signal?: AbortSignal;
  },
): ReadableStream<Uint8Array> {
  const restateUrl = options?.restateUrl ?? "http://localhost:18080";
  const pubsubName = options?.pubsubName ?? "pubsub";
  const offset = options?.lastEventId
    ? parseInt(options.lastEventId, 10)
    : undefined;

  const client = createPubsubClient({
    name: pubsubName,
    ingressUrl: restateUrl,
  });

  return client.sse({
    topic: `session:${sessionId}`,
    offset: Number.isFinite(offset) ? offset : undefined,
    signal: options?.signal,
  });
}

/**
 * Async generator that yields parsed events from a session's pubsub topic.
 *
 * Use this for server-side consumption (e.g., in watchAgentRun or tests).
 * For client-facing SSE, use createSessionSSEStream() instead.
 */
export async function* pullSessionEvents(
  sessionId: string,
  options?: SessionSSEOptions & {
    offset?: number;
    signal?: AbortSignal;
  },
): AsyncGenerator<unknown> {
  const restateUrl = options?.restateUrl ?? "http://localhost:18080";
  const pubsubName = options?.pubsubName ?? "pubsub";

  const client = createPubsubClient({
    name: pubsubName,
    ingressUrl: restateUrl,
  });

  yield* client.pull({
    topic: `session:${sessionId}`,
    offset: options?.offset,
    signal: options?.signal,
  });
}
