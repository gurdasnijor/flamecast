/**
 * HTTP+SSE transport for ACP.
 *
 * Server: listenHttpSse(opts, agentFactory) → HttpSseServer
 * Client: connectHttpSse(opts)              → Promise<acp.Stream>
 */

import * as acp from "@agentclientprotocol/sdk";
import { createServer } from "node:http";

// ─── Server ───────────────────────────────────────────────────────────────

export interface HttpSseServer {
  port: number;
  close(): Promise<void>;
}

export async function listenHttpSse(
  opts: { port: number; host?: string },
  agentFactory: (conn: acp.AgentSideConnection) => acp.Agent,
): Promise<HttpSseServer> {
  const sessions = new Map<string, WritableStreamDefaultWriter<acp.AnyMessage>>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (url.pathname === "/events") {
      const sessionId = crypto.randomUUID();
      const clientToAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
      const agentToClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>();

      sessions.set(sessionId, clientToAgent.writable.getWriter());
      req.on("close", () => sessions.delete(sessionId));

      const stream: acp.Stream = { readable: clientToAgent.readable, writable: agentToClient.writable };
      new acp.AgentSideConnection(agentFactory, stream);

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);

      const reader = agentToClient.readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(`data: ${JSON.stringify(value)}\n\n`);
        }
      } finally {
        res.end();
      }
    } else if (url.pathname === "/jsonrpc" && req.method === "POST") {
      const sessionId = req.headers["x-session-id"] as string;
      const writer = sessionId ? sessions.get(sessionId) : undefined;
      if (!writer) { res.writeHead(400); res.end(); return; }

      let body = "";
      for await (const chunk of req) body += chunk;
      await writer.write(JSON.parse(body) as acp.AnyMessage);
      res.writeHead(202); res.end();
    } else {
      res.writeHead(404); res.end();
    }
  });

  await new Promise<void>((r) => server.listen(opts.port, opts.host, r));
  const addr = server.address() as { port: number };

  return {
    port: addr.port,
    async close() { await new Promise<void>((r) => server.close(() => r())); },
  };
}

// ─── Client ───────────────────────────────────────────────────────────────

export async function connectHttpSse(opts: { url: string; headers?: Record<string, string> }): Promise<acp.Stream> {
  const baseHeaders = opts.headers ?? {};

  // Open SSE connection, read session ID from first message
  const sseRes = await fetch(`${opts.url}/events`, { headers: baseHeaders });
  if (!sseRes.ok) throw new Error(`GET /events failed: ${sseRes.status}`);

  const sseReader = sseRes.body!.getReader();
  const decoder = new TextDecoder();

  let sessionId: string | null = null;
  let leftover = "";
  while (!sessionId) {
    const { done, value } = await sseReader.read();
    if (done) throw new Error("SSE closed before session ID");
    leftover += decoder.decode(value, { stream: true });
    const lines = leftover.split("\n");
    leftover = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.sessionId) { sessionId = parsed.sessionId; break; }
      }
    }
  }

  const writable = new WritableStream<acp.AnyMessage>({
    async write(msg) {
      const res = await fetch(`${opts.url}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": sessionId!, ...baseHeaders },
        body: JSON.stringify(msg),
      });
      if (!res.ok) throw new Error(`POST /jsonrpc failed: ${res.status}`);
    },
  });

  const readable = new ReadableStream<acp.AnyMessage>({
    start(controller) {
      (async () => {
        let buffer = leftover;
        try {
          while (true) {
            const { done, value } = await sseReader.read();
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
        } catch (err) {
          if ((err as Error).name !== "AbortError") controller.error(err);
        }
      })();
    },
  });

  return { readable, writable };
}
