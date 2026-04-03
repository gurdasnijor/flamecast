/**
 * Transport primitives for ACP connections.
 *
 * A ByteConnection is raw bidirectional bytes (what a pipe, socket, or
 * WebSocket gives you). applyCodec bridges bytes → typed messages.
 *
 * Most consumers:
 *   const bytes = await connectStdio({ cmd, args });
 *   const stream = applyCodec(bytes, ndJsonCodec());
 *   const conn = new ClientSideConnection((_a) => client, stream);
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { Codec } from "./codec.js";

// Re-export codecs for backward compat
export { type Codec, ndJsonCodec, jsonCodec } from "./codec.js";

/** Raw bidirectional byte streams + lifecycle. */
export interface ByteConnection {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
  signal: AbortSignal;
}

/**
 * Apply a codec to a byte connection → produces an acp.Stream.
 */
export function applyCodec<T extends acp.AnyMessage>(
  bytes: ByteConnection,
  codec: Codec<T>,
): acp.Stream & { close: () => Promise<void>; signal: AbortSignal } {
  // Pipe encoder output → byte writable
  codec.encoder.readable.pipeTo(bytes.writable).catch(() => {});

  // Pipe byte readable → decoder
  const readable = bytes.readable.pipeThrough(codec.decoder) as ReadableStream<acp.AnyMessage>;

  return {
    readable,
    writable: codec.encoder.writable as unknown as WritableStream<acp.AnyMessage>,
    close: () => bytes.close(),
    signal: bytes.signal,
  };
}
