/**
 * WebSocket transport — both ends.
 *
 * connectWs(opts, factory)       → ClientSideConnection (you're the client)
 * serveWs(opts, factory)         → WsServer (you're the agent, per connection)
 */

import { WebSocket, WebSocketServer } from "ws";
import * as acp from "@agentclientprotocol/sdk";

function wsToStream(ws: WebSocket): acp.Stream {
  let readCtrl: ReadableStreamDefaultController<acp.AnyMessage>;
  const readable = new ReadableStream<acp.AnyMessage>({
    start(c) { readCtrl = c; },
  });

  ws.on("message", (data) => {
    try {
      readCtrl.enqueue(JSON.parse(String(data)));
    } catch {}
  });
  ws.on("close", () => { try { readCtrl.close(); } catch {} });
  ws.on("error", (e) => { try { readCtrl.error(e); } catch {} });

  const writable = new WritableStream<acp.AnyMessage>({
    write(msg) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("ws not open");
      ws.send(JSON.stringify(msg));
    },
  });

  return { readable, writable };
}

// ─── Client end ────────────────────────────────────────────────────────────

export interface WsConnectOptions {
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
}

/** Connect to a remote WS agent → ClientSideConnection. */
export async function connectWs(
  opts: WsConnectOptions,
  clientFactory: (agent: acp.Agent) => acp.Client,
): Promise<acp.ClientSideConnection> {
  const ws = new WebSocket(opts.url, opts.protocols, {
    headers: opts.headers,
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  return new acp.ClientSideConnection(clientFactory, wsToStream(ws));
}

// ─── Agent end ─────────────────────────────────────────────────────────────

export interface WsServerOptions {
  port: number;
  host?: string;
}

export interface WsServer {
  port: number;
  close(): Promise<void>;
}

/** Serve an ACP agent over WebSocket. Each connection gets an AgentSideConnection. */
export async function serveWs(
  opts: WsServerOptions,
  agentFactory: (conn: acp.AgentSideConnection) => acp.Agent,
): Promise<WsServer> {
  const wss = new WebSocketServer({ port: opts.port, host: opts.host });

  wss.on("connection", (ws) => {
    new acp.AgentSideConnection(agentFactory, wsToStream(ws));
  });

  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const addr = wss.address() as { port: number };

  return {
    port: addr.port,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
