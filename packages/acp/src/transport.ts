/**
 * Transport primitives for ACP connections.
 *
 * A ByteConnection is raw bidirectional bytes (what a pipe, socket, or
 * WebSocket gives you). A Codec transforms between typed messages and
 * bytes. Together they produce an acp.Stream for ClientSideConnection.
 *
 * Most consumers just use the connect functions directly:
 *   const bytes = await connectStdio({ cmd, args });
 *   const stream = applyCodec(bytes, ndJsonCodec());
 *   const conn = new ClientSideConnection((_a) => client, stream);
 */

import type * as acp from "@agentclientprotocol/sdk";

/** Raw bidirectional byte streams + lifecycle. */
export interface ByteConnection {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
  signal: AbortSignal;
}

/**
 * Codec — transforms between typed messages and bytes.
 * Each direction is a TransformStream.
 */
export interface Codec<T> {
  encoder: TransformStream<T, Uint8Array>;
  decoder: TransformStream<Uint8Array, T>;
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

// ─── Codecs ─────────────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** ndjson codec — newline-delimited JSON, compatible with acp.ndJsonStream. */
export function ndJsonCodec(): Codec<acp.AnyMessage> {
  return {
    encoder: new TransformStream<acp.AnyMessage, Uint8Array>({
      transform(msg, controller) {
        controller.enqueue(textEncoder.encode(JSON.stringify(msg) + "\n"));
      },
    }),
    decoder: new TransformStream<Uint8Array, acp.AnyMessage>({
      _buffer: "",
      transform(chunk, controller) {
        const self = this as unknown as { _buffer: string };
        self._buffer += textDecoder.decode(chunk, { stream: true });
        const lines = self._buffer.split("\n");
        self._buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) {
            controller.enqueue(JSON.parse(line) as acp.AnyMessage);
          }
        }
      },
    } as Transformer<Uint8Array, acp.AnyMessage> & { _buffer: string }),
  };
}

/** JSON codec for message-oriented transports (WS, HTTP). One message per chunk. */
export function jsonCodec(): Codec<acp.AnyMessage> {
  return {
    encoder: new TransformStream<acp.AnyMessage, Uint8Array>({
      transform(msg, controller) {
        controller.enqueue(textEncoder.encode(JSON.stringify(msg)));
      },
    }),
    decoder: new TransformStream<Uint8Array, acp.AnyMessage>({
      transform(chunk, controller) {
        controller.enqueue(
          JSON.parse(textDecoder.decode(chunk)) as acp.AnyMessage,
        );
      },
    }),
  };
}
