/**
 * HTTP+SSE transport — connects to an agent over HTTP.
 *
 * - Client→Agent: POST JSON-RPC messages to /jsonrpc
 * - Agent→Client: SSE stream of JSON-RPC messages from /events
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { Transport, TransportConnection } from "../transport.js";

export interface HttpSseConnectOptions {
  /** Base URL of the agent's HTTP+SSE endpoint. */
  url: string;
  /** Extra headers to send with every request (e.g. auth). */
  headers?: Record<string, string>;
}

export class HttpSseTransport implements Transport<HttpSseConnectOptions> {
  async connect(opts: HttpSseConnectOptions): Promise<TransportConnection> {
    const ac = new AbortController();
    const baseHeaders = opts.headers ?? {};

    // Client→Agent: writable that POSTs each message
    const writable = new WritableStream<acp.AnyMessage>({
      async write(msg) {
        const res = await fetch(`${opts.url}/jsonrpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...baseHeaders },
          body: JSON.stringify(msg),
          signal: ac.signal,
        });
        if (!res.ok) {
          throw new Error(`POST /jsonrpc failed: ${res.status}`);
        }
      },
    });

    // Agent→Client: readable that consumes SSE
    const readable = new ReadableStream<acp.AnyMessage>({
      start(controller) {
        fetch(`${opts.url}/events`, {
          headers: baseHeaders,
          signal: ac.signal,
        })
          .then(async (res) => {
            if (!res.ok) {
              controller.error(
                new Error(`GET /events failed: ${res.status}`),
              );
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
                  const msg = JSON.parse(line.slice(6)) as acp.AnyMessage;
                  controller.enqueue(msg);
                }
              }
            }
            controller.close();
          })
          .catch((err) => {
            if (err.name !== "AbortError") {
              controller.error(err);
            }
          });
      },
    });

    const stream: acp.Stream = { readable, writable };

    return {
      stream,
      signal: ac.signal,
      async close() {
        ac.abort();
      },
    };
  }
}
