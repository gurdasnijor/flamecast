/**
 * HTTP+SSE — connects to an agent over HTTP.
 * Client→Agent: POST bytes to /jsonrpc
 * Agent→Client: SSE stream of bytes from /events
 *
 * Note: HTTP+SSE is inherently message-oriented (one POST per message,
 * one SSE data: line per message). The byte streams here carry one
 * JSON message per chunk — use jsonCodec() not ndJsonCodec().
 */

import type { ByteConnection } from "../transport.js";

export interface HttpSseConnectOptions {
  url: string;
  headers?: Record<string, string>;
}

const enc = new TextEncoder();

export async function connectHttpSse(
  opts: HttpSseConnectOptions,
): Promise<ByteConnection> {
  const ac = new AbortController();
  const baseHeaders = opts.headers ?? {};

  // Client→Agent: each write POSTs one message as bytes
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      const res = await fetch(`${opts.url}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...baseHeaders },
        body: Buffer.from(chunk),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new Error(`POST /jsonrpc failed: ${res.status}`);
      }
    },
  });

  // Agent→Client: SSE stream, each data: line is one message as bytes
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      fetch(`${opts.url}/events`, {
        headers: baseHeaders,
        signal: ac.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            controller.error(new Error(`GET /events failed: ${res.status}`));
            return;
          }

          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop()!;

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                controller.enqueue(enc.encode(line.slice(6)));
              }
            }
          }
          controller.close();
        })
        .catch((err) => {
          if (err.name !== "AbortError") controller.error(err);
        });
    },
  });

  return {
    readable,
    writable,
    signal: ac.signal,
    async close() { ac.abort(); },
  };
}
