/**
 * WebSocket transport — connects to an agent over a single WebSocket.
 *
 * - Client→Agent: JSON-RPC messages sent as WS text frames
 * - Agent→Client: JSON-RPC messages received as WS text frames
 *
 * Simplest transport — fully bidirectional over one connection.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { WebSocket } from "ws";
import type { Transport, TransportConnection } from "../transport.js";

export interface WsConnectOptions {
  /** WebSocket URL of the agent (e.g. "ws://localhost:8080"). */
  url: string;
  /** Extra headers sent during the WS handshake (e.g. auth). */
  headers?: Record<string, string>;
  /** Subprotocols to request. */
  protocols?: string[];
}

export class WsTransport implements Transport<WsConnectOptions> {
  async connect(opts: WsConnectOptions): Promise<TransportConnection> {
    const ac = new AbortController();

    const ws = new WebSocket(opts.url, opts.protocols, {
      headers: opts.headers,
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.on("close", () => ac.abort());
    ws.on("error", () => ac.abort());

    // Agent→Client: readable that receives WS messages
    let readableController: ReadableStreamDefaultController<acp.AnyMessage>;
    const readable = new ReadableStream<acp.AnyMessage>({
      start(controller) {
        readableController = controller;
      },
    });

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf-8");
      const msg = JSON.parse(text) as acp.AnyMessage;
      readableController.enqueue(msg);
    });

    ws.once("close", () => {
      try {
        readableController.close();
      } catch {
        // already closed
      }
    });

    // Client→Agent: writable that sends WS messages
    const writable = new WritableStream<acp.AnyMessage>({
      write(msg) {
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket is not open");
        }
        ws.send(JSON.stringify(msg));
      },
    });

    const stream: acp.Stream = { readable, writable };

    return {
      stream,
      signal: ac.signal,
      async close() {
        ws.close();
      },
    };
  }
}
