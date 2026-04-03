/**
 * NATS transport — ACP messages over a NATS message bus.
 *
 * Each ACP session gets a subject pair:
 *   - acp.{sessionId}.c2a — client → agent messages
 *   - acp.{sessionId}.a2c — agent → client messages
 *
 * Uses core NATS pub/sub for low-latency delivery. Messages are JSON
 * encoded on the wire. JetStream can be layered on top for durability
 * by subscribing to the same subjects via a JetStream consumer.
 *
 * This enables:
 *   - Decoupled deployment (agent and client need only NATS connectivity)
 *   - Geographic distribution (NATS clusters/superclusters)
 *   - Fan-out (multiple subscribers on the same subject)
 *   - No direct TCP connection between client and agent
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { Transport, TransportConnection } from "../transport.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SUBJECT_PREFIX = "acp";

function c2aSubject(sessionId: string) {
  return `${SUBJECT_PREFIX}.${sessionId}.c2a`;
}
function a2cSubject(sessionId: string) {
  return `${SUBJECT_PREFIX}.${sessionId}.a2c`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Create a readable stream from a NATS subscription.
 */
function natsReadable(
  sub: Subscription,
  ac: AbortController,
): ReadableStream<acp.AnyMessage> {
  return new ReadableStream<acp.AnyMessage>({
    async start(controller) {
      (async () => {
        for await (const msg of sub) {
          if (ac.signal.aborted) break;
          try {
            const parsed = JSON.parse(dec.decode(msg.data)) as acp.AnyMessage;
            controller.enqueue(parsed);
          } catch {
            // skip malformed
          }
        }
        try {
          controller.close();
        } catch {}
      })();
    },
    cancel() {
      sub.unsubscribe();
    },
  });
}

/**
 * Create a writable stream that publishes to a NATS subject.
 */
function natsWritable(
  nc: NatsConnection,
  subject: string,
): WritableStream<acp.AnyMessage> {
  return new WritableStream<acp.AnyMessage>({
    write(msg) {
      nc.publish(subject, enc.encode(JSON.stringify(msg)));
    },
  });
}

// ─── Client-side transport ──────────────────────────────────────────────────

export interface NatsConnectOptions {
  /** Agent name or routing key. */
  agentName: string;
  /** Override session ID (default: random). */
  sessionId?: string;
}

export class NatsTransport implements Transport<NatsConnectOptions> {
  constructor(private nc: NatsConnection) {}

  async connect(opts: NatsConnectOptions): Promise<TransportConnection> {
    const sessionId =
      opts.sessionId ??
      `${opts.agentName}-${crypto.randomUUID().slice(0, 8)}`;
    const ac = new AbortController();

    // Client writes to c2a, reads from a2c
    const sub = this.nc.subscribe(a2cSubject(sessionId));
    const readable = natsReadable(sub, ac);
    const writable = natsWritable(this.nc, c2aSubject(sessionId));

    return {
      stream: { readable, writable },
      signal: ac.signal,
      async close() {
        sub.unsubscribe();
        ac.abort();
      },
    };
  }
}

// ─── Agent-side stream factory ──────────────────────────────────────────────

/**
 * Create an acp.Stream for the agent side of a NATS session.
 * Agent reads from c2a, writes to a2c (opposite of client).
 */
export function createNatsAgentStream(
  nc: NatsConnection,
  sessionId: string,
): { stream: acp.Stream; close: () => void } {
  const ac = new AbortController();

  // Agent reads from c2a, writes to a2c
  const sub = nc.subscribe(c2aSubject(sessionId));
  const readable = natsReadable(sub, ac);
  const writable = natsWritable(nc, a2cSubject(sessionId));

  return {
    stream: { readable, writable },
    close() {
      sub.unsubscribe();
      ac.abort();
    },
  };
}

export { SUBJECT_PREFIX, c2aSubject, a2cSubject };
