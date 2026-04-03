/**
 * Protobuf transport — binary-encoded ACP messages over WebSocket.
 *
 * Uses protobuf framing instead of ndjson for efficient service-to-service
 * ACP communication. Each WS binary frame is a single RpcMessage proto.
 *
 * Wire format:
 *   - Client→Agent: WS binary frames (protobuf-encoded RpcMessage)
 *   - Agent→Client: WS binary frames (protobuf-encoded RpcMessage)
 *
 * The JSON-RPC params/result are carried as bytes fields — the envelope
 * is protobuf, the payload is JSON bytes. This avoids ndjson parsing
 * while keeping compatibility with the existing ACP schema. Future:
 * hot-path messages (prompt, sessionUpdate) can get fully-typed protos.
 */

import { resolve } from "node:path";
import { WebSocket } from "ws";
import * as protobuf from "protobufjs";
import type * as acp from "@agentclientprotocol/sdk";
import type { Transport, TransportConnection } from "../transport.js";

// ─── Proto schema loading ───────────────────────────────────────────────────

const protoPath = resolve(
  import.meta.dirname,
  "../../proto/acp_rpc.proto",
);

let _root: protobuf.Root | null = null;
let _RpcMessage: protobuf.Type;

async function loadProto() {
  if (_root) return;
  _root = await protobuf.load(protoPath);
  _RpcMessage = _root.lookupType("acp_rpc.RpcMessage");
}

// ─── JSON-RPC ↔ Protobuf conversion ────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

type JsonRpcMessage = acp.AnyMessage & Record<string, unknown>;

/**
 * Encode a JSON-RPC message object to a protobuf binary buffer.
 *
 * ID handling: uses `oneof id_present { string id }` in the proto.
 * - Request/response: id field is set (numeric IDs stringified)
 * - Notification: id field is absent (oneof not set)
 */
function jsonRpcToProto(msg: JsonRpcMessage): Uint8Array {
  const payload: Record<string, unknown> = {};

  // ID — stringify numbers, omit entirely for notifications
  if (msg.id !== undefined && msg.id !== null) {
    payload.id = String(msg.id);
  }

  if (msg.method) {
    payload.method = msg.method;
  }

  if (msg.params !== undefined) {
    payload.params = enc.encode(JSON.stringify(msg.params));
  }

  if (msg.result !== undefined) {
    payload.result = enc.encode(JSON.stringify(msg.result));
  }

  if (msg.error !== undefined) {
    const err = msg.error as {
      code: number;
      message: string;
      data?: unknown;
    };
    payload.error = {
      code: err.code,
      message: err.message,
      data:
        err.data !== undefined
          ? enc.encode(JSON.stringify(err.data))
          : undefined,
    };
  }

  return _RpcMessage.encode(_RpcMessage.create(payload)).finish();
}

/**
 * Decode a protobuf binary buffer to a JSON-RPC message object.
 *
 * ID handling: if `oneof id_present` is set, parse the string back
 * to a number if it looks numeric (JSON-RPC convention).
 */
function protoToJsonRpc(buf: Uint8Array): JsonRpcMessage {
  const decoded = _RpcMessage.toObject(
    _RpcMessage.decode(buf),
    { defaults: false, oneofs: true },
  ) as {
    idPresent?: string;
    id?: string;
    method?: string;
    params?: Uint8Array;
    result?: Uint8Array;
    error?: { code?: number; message?: string; data?: Uint8Array };
  };

  const msg: Record<string, unknown> = { jsonrpc: "2.0" };

  // ID — restore from oneof. Parse numeric strings back to numbers.
  if (decoded.idPresent === "id" && decoded.id !== undefined) {
    const num = Number(decoded.id);
    msg.id = Number.isFinite(num) ? num : decoded.id;
  }

  if (decoded.method) {
    msg.method = decoded.method;
  }

  if (decoded.params && decoded.params.length > 0) {
    msg.params = JSON.parse(dec.decode(decoded.params));
  }

  if (decoded.result && decoded.result.length > 0) {
    msg.result = JSON.parse(dec.decode(decoded.result));
  }

  if (decoded.error) {
    msg.error = {
      code: decoded.error.code ?? 0,
      message: decoded.error.message ?? "",
      ...(decoded.error.data && decoded.error.data.length > 0
        ? { data: JSON.parse(dec.decode(decoded.error.data)) }
        : {}),
    };
  }

  return msg as JsonRpcMessage;
}

// ─── Transport ──────────────────────────────────────────────────────────────

export interface ProtobufWsConnectOptions {
  /** WebSocket URL of the agent (e.g. "ws://localhost:8080"). */
  url: string;
  /** Extra headers sent during the WS handshake. */
  headers?: Record<string, string>;
}

export class ProtobufWsTransport
  implements Transport<ProtobufWsConnectOptions>
{
  async connect(
    opts: ProtobufWsConnectOptions,
  ): Promise<TransportConnection> {
    await loadProto();

    const ac = new AbortController();
    const ws = new WebSocket(opts.url, ["acp-protobuf"], {
      headers: opts.headers,
    });
    ws.binaryType = "nodebuffer";

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.on("close", () => ac.abort());
    ws.on("error", () => ac.abort());

    let readableController: ReadableStreamDefaultController<acp.AnyMessage>;
    const readable = new ReadableStream<acp.AnyMessage>({
      start(controller) {
        readableController = controller;
      },
    });

    ws.on("message", (data) => {
      const buf =
        data instanceof Uint8Array
          ? data
          : new Uint8Array(data as Buffer);
      readableController.enqueue(protoToJsonRpc(buf));
    });

    ws.once("close", () => {
      try {
        readableController.close();
      } catch {}
    });

    const writable = new WritableStream<acp.AnyMessage>({
      write(msg) {
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket is not open");
        }
        ws.send(jsonRpcToProto(msg as JsonRpcMessage));
      },
    });

    return {
      stream: { readable, writable },
      signal: ac.signal,
      async close() {
        ws.close();
      },
    };
  }
}

// ─── Exported helpers for server-side use ───────────────────────────────────

export { loadProto, jsonRpcToProto, protoToJsonRpc };
