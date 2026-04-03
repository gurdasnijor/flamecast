/**
 * AgentConnectionFactory — resolves an agent name and connects via
 * the appropriate transport, returning a ClientSideConnection.
 *
 * Two usage patterns:
 *
 * 1. PooledConnectionFactory (recommended) — warmed at boot:
 *    const { conn, acpSessionId } = await pool.connect("claude", client);
 *    await conn.prompt({ sessionId: acpSessionId, ... });
 *
 * 2. Raw factory — caller does handshake:
 *    const { conn } = await factory.connect("claude", client);
 *    await conn.initialize({ ... });
 *    const session = await conn.newSession({ ... });
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

export type { acp };
