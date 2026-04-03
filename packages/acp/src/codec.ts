/**
 * Generic codecs for message serialization over byte streams.
 *
 * A Codec<T> transforms between typed messages and bytes via a pair
 * of TransformStreams. Not ACP-specific — works with any message type
 * that serializes to JSON.
 */

/** Bidirectional message ↔ bytes transform. */
export interface Codec<T> {
  encoder: TransformStream<T, Uint8Array>;
  decoder: TransformStream<Uint8Array, T>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Newline-delimited JSON codec.
 * Each message is one JSON object followed by '\n'.
 * Used for streaming transports (stdio pipes).
 */
export function ndJsonCodec<T = unknown>(): Codec<T> {
  return {
    encoder: new TransformStream<T, Uint8Array>({
      transform(msg, controller) {
        controller.enqueue(textEncoder.encode(JSON.stringify(msg) + "\n"));
      },
    }),
    decoder: new TransformStream<Uint8Array, T>({
      _buffer: "",
      transform(chunk, controller) {
        const self = this as unknown as { _buffer: string };
        self._buffer += textDecoder.decode(chunk, { stream: true });
        const lines = self._buffer.split("\n");
        self._buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) {
            controller.enqueue(JSON.parse(line) as T);
          }
        }
      },
    } as Transformer<Uint8Array, T> & { _buffer: string }),
  };
}

/**
 * Single-message JSON codec.
 * Each chunk is exactly one JSON object (no delimiter).
 * Used for message-oriented transports (WebSocket, HTTP+SSE).
 */
export function jsonCodec<T = unknown>(): Codec<T> {
  return {
    encoder: new TransformStream<T, Uint8Array>({
      transform(msg, controller) {
        controller.enqueue(textEncoder.encode(JSON.stringify(msg)));
      },
    }),
    decoder: new TransformStream<Uint8Array, T>({
      transform(chunk, controller) {
        controller.enqueue(
          JSON.parse(textDecoder.decode(chunk)) as T,
        );
      },
    }),
  };
}
