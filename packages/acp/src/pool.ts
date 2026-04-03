/**
 * PooledConnectionFactory — process table for agent connections.
 *
 * One process per agent name. The pool holds the initialized
 * ClientSideConnection with a delegating acp.Client. Each handler
 * invocation swaps the delegate before calling prompt/newSession.
 *
 * Pattern:
 *   pool holds:  { conn (initialized), delegatingClient, close }
 *   per handler: caller passes their acp.Client → pool sets active → returns conn
 */

import * as acp from "@agentclientprotocol/sdk";
import type { AgentConnectionFactory, AgentConnectionResult } from "./acp-client.js";

interface PoolEntry {
  conn: acp.ClientSideConnection;
  close: () => Promise<void>;
  setActive: (client: acp.Client) => void;
}

export class PooledConnectionFactory implements AgentConnectionFactory {
  private pool = new Map<string, PoolEntry>();

  constructor(private inner: AgentConnectionFactory) {}

  async connect(
    agentName: string,
    client: acp.Client,
  ): Promise<AgentConnectionResult> {
    let entry = this.pool.get(agentName);

    if (!entry) {
      // First connection — spawn agent, initialize, store in pool.
      // Create a delegating client that routes to the active caller's client.
      let active: acp.Client = client;

      const delegatingClient: acp.Client = {
        async requestPermission(params) { return active.requestPermission(params); },
        async sessionUpdate(params) { return active.sessionUpdate(params); },
        async readTextFile(params) { return active.readTextFile!(params); },
        async writeTextFile(params) { return active.writeTextFile!(params); },
        async createTerminal(params) { return active.createTerminal!(params); },
        async terminalOutput(params) { return active.terminalOutput!(params); },
        async releaseTerminal(params) { return active.releaseTerminal!(params); },
        async waitForTerminalExit(params) { return active.waitForTerminalExit!(params); },
        async killTerminal(params) { return active.killTerminal!(params); },
        async extMethod(method, params) { return active.extMethod!(method, params); },
        async extNotification(method, params) { return active.extNotification!(method, params); },
      };

      const result = await this.inner.connect(agentName, delegatingClient);

      // Initialize once per process
      await result.conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        clientInfo: {
          name: "flamecast",
          title: "Flamecast",
          version: "0.1.0",
        },
      });

      entry = {
        conn: result.conn,
        close: result.close,
        setActive: (c) => { active = c; },
      };
      this.pool.set(agentName, entry);
    } else {
      // Reuse — swap the active client to the caller's
      entry.setActive(client);
    }

    return {
      conn: entry.conn,
      close: async () => {
        // Per-session close is a no-op — use shutdown() for process cleanup
      },
    };
  }

  async shutdown(): Promise<void> {
    const entries = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(entries.map((e) => e.close()));
  }

  async kill(agentName: string): Promise<void> {
    const entry = this.pool.get(agentName);
    if (entry) {
      this.pool.delete(agentName);
      await entry.close();
    }
  }
}
