/**
 * Transport — the pluggable wire layer for ACP connections.
 *
 * A Transport produces TransportConnections. Each connection carries
 * an acp.Stream ({ readable, writable } of JSON-RPC messages) over
 * some wire protocol (stdio, HTTP+SSE, WebSocket).
 *
 * Everything above this (initialize, newSession, prompt, permissions)
 * is protocol-level, not transport-level.
 */

import type * as acp from "@agentclientprotocol/sdk";

export interface TransportConnection {
  stream: acp.Stream;
  close(): Promise<void>;
  /** Fires when the underlying wire dies. */
  signal: AbortSignal;
}

/**
 * A transport knows how to connect given some options and return
 * a TransportConnection. Each transport type has its own options
 * shape (stdio needs cmd+args, HTTP needs a URL, WS needs an endpoint).
 */
export interface Transport<TOptions> {
  connect(opts: TOptions): Promise<TransportConnection>;
}
