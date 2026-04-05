/**
 * createDurableStream — returns a standard acp.Stream backed by Restate.
 *
 * Use with the standard ACP SDK ClientSideConnection:
 *
 *   const stream = createDurableStream({ connectionId, ingressUrl });
 *   const conn = new acp.ClientSideConnection(() => myClient, stream);
 *   await conn.initialize({...});
 *   await conn.prompt({...});
 *
 * Same interface as ndJsonStream, fromWebSocket, connectHttpSse —
 * just a different backing. Agents and clients don't know Restate exists.
 *
 * Writable: POSTs each AnyMessage to AcpConnection/{id}/fromClient via Restate ingress
 * Readable: Pulls messages from Restate pubsub (topic = connectionId)
 */

import type * as acp from "@agentclientprotocol/sdk";
import { createPubsubClient } from "@restatedev/pubsub-client";
import type { LogEntry } from "./connection.js";

export interface DurableStreamOptions {
  /** The AcpConnection VO key */
  connectionId: string;
  /** Restate ingress URL (e.g. "http://localhost:8080") */
  ingressUrl: string;
  /** Optional HTTP headers for auth */
  headers?: Record<string, string>;
  /** Pubsub pull interval in ms (default: 300) */
  pullIntervalMs?: number;
}

export function createDurableStream(opts: DurableStreamOptions): acp.Stream {
  const { connectionId, ingressUrl, headers = {} } = opts;

  // ─── Writable: client messages → VO via Restate ingress ─────────────────

  const writable = new WritableStream<acp.AnyMessage>({
    async write(message) {
      const res = await fetch(
        `${ingressUrl}/AcpConnection/${encodeURIComponent(connectionId)}/fromClient`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(message),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`fromClient failed: ${res.status} ${text}`);
      }
    },
  });

  // ─── Readable: agent messages ← VO via Restate pubsub ──────────────────

  const pubsub = createPubsubClient({
    name: "pubsub",
    ingressUrl,
    headers,
    pullInterval: { milliseconds: opts.pullIntervalMs ?? 300 },
  });

  // AbortController for cancellation — if the readable consumer disconnects,
  // the pubsub pull loop is cleaned up.
  const ac = new AbortController();

  const readable = new ReadableStream<acp.AnyMessage>({
    start(controller) {
      (async () => {
        try {
          for await (const entry of pubsub.pull({ topic: connectionId, signal: ac.signal })) {
            const logEntry = entry as LogEntry;
            controller.enqueue(logEntry.message);
          }
          controller.close();
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            controller.error(err);
          } else {
            try { controller.close(); } catch {}
          }
        }
      })();
    },
    cancel() {
      ac.abort();
    },
  });

  return { readable, writable };
}
