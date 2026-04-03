/**
 * AgentConnectionFactory — resolves an agent name and connects via
 * the appropriate transport, returning a ClientSideConnection.
 *
 * The factory picks the transport based on the agent's distribution
 * type (stdio, websocket, http+sse). The caller does the ACP handshake
 * (initialize + newSession) themselves.
 *
 *   const { conn, close } = await factory.connect("claude-acp", myClient);
 *   await conn.initialize({ ... });
 *   const session = await conn.newSession({ ... });
 *   const result = await conn.prompt({ ... });
 *   await close();
 */

import * as acp from "@agentclientprotocol/sdk";
export interface AgentConnectionResult {
  conn: acp.ClientSideConnection;
  close: () => Promise<void>;
}

export interface AgentConnectionFactory {
  connect(
    agentName: string,
    client: acp.Client,
  ): Promise<AgentConnectionResult>;
}

export type { acp };
