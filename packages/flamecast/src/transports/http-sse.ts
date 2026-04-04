/**
 * HTTP+SSE transport.
 *
 * fromHttpSse(opts)                  → Promise<acp.Stream>  (primitive)
 * acceptHttpSse(handler)             → HttpSseHandler        (primitive)
 * connectHttpSse(opts, factory)      → ClientSideConnection  (composed)
 * serveHttpSse(factory)              → HttpSseHandler         (composed)
 */

import * as acp from "@agentclientprotocol/sdk";

const enc = new TextEncoder();

// ─── Primitives ────────────────────────────────────────────────────────────

export interface HttpSseConnectOptions {
  url: string;
  headers?: Record<string, string>;
}

export async function fromHttpSse(opts: HttpSseConnectOptions): Promise<acp.Stream> {
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
      fetch(`${opts.url}/events`, { headers: baseHeaders, signal: ac.signal })
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
                try { controller.enqueue(JSON.parse(line.slice(6))); } catch {}
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

  return { readable, writable };
}

export interface HttpSseHandler {
  handleEvents(req: Request): Response;
  handleJsonRpc(req: Request): Promise<Response>;
}

export function acceptHttpSse(
  handler: (stream: acp.Stream, sessionId: string) => void,
): HttpSseHandler {
  const sessions = new Map<string, WritableStreamDefaultWriter<acp.AnyMessage>>();

  function handleEvents(req: Request): Response {
    const sessionId = crypto.randomUUID();
    const clientToAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
    const agentToClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>();

    sessions.set(sessionId, clientToAgent.writable.getWriter());
    req.signal.addEventListener("abort", () => sessions.delete(sessionId));

    handler(
      { readable: clientToAgent.readable, writable: agentToClient.writable },
      sessionId,
    );

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

// ─── Composed ──────────────────────────────────────────────────────────────

export async function connectHttpSse(
  opts: HttpSseConnectOptions,
  toClient: (agent: acp.Agent) => acp.Client,
): Promise<acp.ClientSideConnection> {
  return new acp.ClientSideConnection(toClient, await fromHttpSse(opts));
}

export function serveHttpSse(
  agentFactory: (conn: acp.AgentSideConnection) => acp.Agent,
): HttpSseHandler {
  return acceptHttpSse((s) => new acp.AgentSideConnection(agentFactory, s));
}
