/**
 * WebSocket — connects to an agent over WS, returns byte streams.
 * Each WS message is one chunk (text or binary).
 */

import { WebSocket } from "ws";
import type { ByteConnection } from "../transport.js";

export interface WsConnectOptions {
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
}

export async function connectWs(
  opts: WsConnectOptions,
): Promise<ByteConnection> {
  const ac = new AbortController();
  const enc = new TextEncoder();

  const ws = new WebSocket(opts.url, opts.protocols, {
    headers: opts.headers,
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.on("close", () => ac.abort());
  ws.on("error", () => ac.abort());

  let readCtrl: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readCtrl = controller;
    },
  });

  ws.on("message", (data) => {
    if (data instanceof Uint8Array) {
      readCtrl.enqueue(data);
    } else if (typeof data === "string") {
      readCtrl.enqueue(enc.encode(data));
    } else if (Buffer.isBuffer(data)) {
      readCtrl.enqueue(new Uint8Array(data));
    } else {
      readCtrl.enqueue(new Uint8Array(Buffer.concat(data as Buffer[])));
    }
  });

  ws.once("close", () => {
    try { readCtrl.close(); } catch {}
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      ws.send(chunk);
    },
  });

  return {
    readable,
    writable,
    signal: ac.signal,
    async close() { ws.close(); },
  };
}
