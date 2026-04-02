/**
 * Pluggable agent transport — abstracts how the gateway connects to agents.
 *
 * ClientSideConnection just needs a Stream ({ readable, writable } of parsed
 * JSON-RPC messages). The transport provides that stream over different
 * wire protocols: stdio, HTTP+SSE, WebSocket.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { SpawnConfig } from "./registry.js";

export interface TransportConnection {
  stream: acp.Stream;
  close(): Promise<void>;
  cancel?(): Promise<void>;
}

export interface AgentTransport {
  connect(config: SpawnConfig, runId: string, cwd: string): Promise<TransportConnection>;
}
