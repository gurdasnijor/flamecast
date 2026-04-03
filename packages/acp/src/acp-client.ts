/**
 * AcpClient — lightweight multiplexing ACP client for protocol testing.
 *
 * Manages multiple agent connections over a pluggable transport.
 * No Restate dependency — pure ACP protocol.
 *
 * For Restate-based usage, use PooledConnectionFactory from @flamecast/sdk.
 */

import * as acp from "@agentclientprotocol/sdk";
import type { Transport, TransportConnection } from "./transport.js";

export interface AcpClientConnectOptions {
  onSessionUpdate?: (update: acp.SessionNotification) => void;
  onPermissionRequest?: (
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  cwd?: string;
}

interface ManagedSession {
  agentName: string;
  sessionId: string;
  transport: TransportConnection;
  conn: acp.ClientSideConnection;
}

export class AcpClient {
  private transport: Transport<{ agentName: string }>;
  private sessions = new Map<string, ManagedSession>();

  constructor(opts: { transport: Transport<{ agentName: string }> }) {
    this.transport = opts.transport;
  }

  async connect(
    agentName: string,
    opts: AcpClientConnectOptions = {},
  ): Promise<{ sessionId: string; agentName: string }> {
    const transport = await this.transport.connect({ agentName });

    const client: acp.Client = {
      async requestPermission(params) {
        if (opts.onPermissionRequest) return opts.onPermissionRequest(params);
        return {
          outcome: { outcome: "selected", optionId: params.options[0].optionId },
        };
      },
      async sessionUpdate(params) {
        opts.onSessionUpdate?.(params);
      },
    };

    const conn = new acp.ClientSideConnection(() => client, transport.stream);

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "acp-client", title: "ACP Client", version: "0.1.0" },
    });

    const session = await conn.newSession({
      cwd: opts.cwd ?? process.cwd(),
      mcpServers: [],
    });

    this.sessions.set(session.sessionId, {
      agentName,
      sessionId: session.sessionId,
      transport,
      conn,
    });

    return { sessionId: session.sessionId, agentName };
  }

  async prompt(sessionId: string, text: string): Promise<acp.PromptResponse> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`No session: ${sessionId}`);
    return s.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`No session: ${sessionId}`);
    await s.conn.cancel({ sessionId });
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    await s.transport.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.transport.close()));
  }

  sessions_list(): Array<{ sessionId: string; agentName: string }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      agentName: s.agentName,
    }));
  }
}
