/**
 * Agent connection factory — internal interface for process management.
 *
 * This is Restate-specific plumbing, not ACP protocol.
 * The factory resolves agent names and returns initialized connections.
 * The pool wraps it to reuse processes across handler invocations.
 */

import * as acp from "@agentclientprotocol/sdk";

export interface AgentConnectionResult {
  conn: acp.ClientSideConnection;
  /** Pre-created ACP session ID (set by PooledConnectionFactory). */
  acpSessionId?: string;
  close: () => Promise<void>;
}

export interface AgentConnectionFactory {
  connect(
    agentName: string,
    client: acp.Client,
  ): Promise<AgentConnectionResult>;
}
