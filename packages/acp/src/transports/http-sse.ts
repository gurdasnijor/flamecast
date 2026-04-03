/**
 * HTTP+SSE transport — both ends.
 *
 * connectHttpSse(opts, factory) → ClientSideConnection (you're the client)
 * serveHttpSse(factory)         → { handleEvents, handleJsonRpc } (you're the agent)
 *
 * Wire: POST /jsonrpc per message, GET /events for SSE stream.
 * Message-oriented — one JSON object per chunk.
 */

import * as acp from "@agentclientprotocol/sdk";

const enc = new TextEncoder();

// ─── Client end ────────────────────────────────────────────────────────────

export interface HttpSseConnectOptions {
  url: string;
  headers?: Record<string, string>;
}

/** Connect to a remote HTTP+SSE agent → ClientSideConnection. */
export async function connectHttpSse(
  opts: HttpSseConnectOptions,
  clientFactory: (agent: acp.Agent) => acp.Client,
): Promise<acp.ClientSideConnection> {
  const ac = new AbortController();
  const baseHeaders = opts.headers ?? {};

  const writable = new WritableStream<acp.AnyMessage>({
    async write(msg) {
      const res = await fetch(`${opts.url}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...baseHeaders },
        body: JSON.stringify(msg),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`POST /jsonrpc failed: ${res.status}`);
    },
  });

  const readable = new ReadableStream<acp.AnyMessage>({
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
                try {
                  controller.enqueue(JSON.parse(line.slice(6)));
                } catch {}
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

  return new acp.ClientSideConnection(clientFactory, { readable, writable });
}

// ─── Agent end ─────────────────────────────────────────────────────────────

export interface HttpSseHandler {
  handleEvents(req: Request): Response;
  handleJsonRpc(req: Request): Promise<Response>;
}

/** Serve an ACP agent over HTTP+SSE. Each GET /events creates an AgentSideConnection. */
export function serveHttpSse(
  agentFactory: (conn: acp.AgentSideConnection) => acp.Agent,
): HttpSseHandler {
  const sessions = new Map<string, WritableStreamDefaultWriter<acp.AnyMessage>>();

  function handleEvents(req: Request): Response {
    const sessionId = crypto.randomUUID();
    const clientToAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
    const agentToClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>();

    sessions.set(sessionId, clientToAgent.writable.getWriter());
    req.signal.addEventListener("abort", () => sessions.delete(sessionId));

    new acp.AgentSideConnection(agentFactory, {
      readable: clientToAgent.readable,
      writable: agentToClient.writable,
    });

    const sseBody = new ReadableStream({
      async start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ sessionId })}\n\n`));
        const reader = agentToClient.readable.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`));
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(sseBody, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Session-Id": sessionId,
      },
    });
  }

  async function handleJsonRpc(req: Request): Promise<Response> {
    const sessionId = req.headers.get("X-Session-Id");
    if (!sessionId) return new Response("missing X-Session-Id", { status: 400 });

    const writer = sessions.get(sessionId);
    if (!writer) return new Response("session not found", { status: 410 });

    const msg = (await req.json()) as acp.AnyMessage;
    await writer.write(msg);
    return new Response(null, { status: 202 });
  }

  return { handleEvents, handleJsonRpc };
}
