/**
 * WebSocket transport.
 *
 * fromWebSocket(ws)                → acp.Stream  (primitive)
 * acceptWs(opts, handler)          → Server      (primitive)
 * connectWs(opts, factory)         → ClientSideConnection  (composed)
 * serveWs(opts, factory)           → Server                (composed)
 */

import { WebSocket, WebSocketServer } from "ws";
import * as acp from "@agentclientprotocol/sdk";

export function fromWebSocket(ws: WebSocket): acp.Stream {
  let readCtrl: ReadableStreamDefaultController<acp.AnyMessage>;
  const readable = new ReadableStream<acp.AnyMessage>({
    start(c) { readCtrl = c; },
  });

  ws.on("message", (data) => {
    try { readCtrl.enqueue(JSON.parse(String(data))); } catch {}
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

// ─── Primitives ────────────────────────────────────────────────────────────

export interface WsConnectOptions {
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
}

export interface Server {
  port: number;
  close(): Promise<void>;
}

export async function acceptWs(
  opts: { port: number; host?: string },
  handler: (stream: acp.Stream) => void,
): Promise<Server> {
  const wss = new WebSocketServer({ port: opts.port, host: opts.host });
  wss.on("connection", (ws) => handler(fromWebSocket(ws)));
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

// ─── Composed ──────────────────────────────────────────────────────────────

export async function connectWs(
  opts: WsConnectOptions,
  toClient: (agent: acp.Agent) => acp.Client,
): Promise<acp.ClientSideConnection> {
  const ws = new WebSocket(opts.url, opts.protocols, { headers: opts.headers });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return new acp.ClientSideConnection(toClient, fromWebSocket(ws));
}

export async function serveWs(
  opts: { port: number; host?: string },
  agentFactory: (conn: acp.AgentSideConnection) => acp.Agent,
): Promise<Server> {
  return acceptWs(opts, (s) => new acp.AgentSideConnection(agentFactory, s));
}
