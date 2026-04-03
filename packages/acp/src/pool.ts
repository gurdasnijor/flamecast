/**
 * PooledConnectionFactory — process table for agent connections.
 *
 * One process per agent name, warmed at boot. The pool holds
 * the initialized ClientSideConnection + ACP session per agent.
 * Handler invocations swap the delegate client before calling prompt.
 *
 * Boot sequence:
 *   1. warmup(["claude", "codex"]) — spawn, initialize, newSession per agent
 *   2. configureAcp(pool) — wire into VO handlers
 *   3. serve() — start Restate endpoint
 *
 * Handler sequence:
 *   1. factory.connect(agentName, client) — swap delegate, return warm conn
 *   2. conn.prompt({ sessionId }) — uses the pre-created session
 */

import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentConnectionFactory,
  AgentConnectionResult,
} from "./acp-client.js";

interface PoolEntry {
  conn: acp.ClientSideConnection;
  acpSessionId: string;
  close: () => Promise<void>;
  setActive: (client: acp.Client) => void;
}

/** No-op client used during warmup (no handler context yet). */
const warmupClient: acp.Client = {
  async requestPermission(params) {
    return {
      outcome: { outcome: "selected", optionId: params.options[0].optionId },
    };
  },
  async sessionUpdate() {},
};

export class PooledConnectionFactory implements AgentConnectionFactory {
  private pool = new Map<string, PoolEntry>();

  constructor(private inner: AgentConnectionFactory) {}

  /**
   * Eagerly spawn + initialize + newSession for each agent.
   * Call before serve(). After this, all agents are warm.
   */
  async warmup(
    agentNames: string[],
    opts?: { cwd?: string; retries?: number; retryDelayMs?: number },
  ): Promise<Map<string, string>> {
    const sessions = new Map<string, string>();
    const maxRetries = opts?.retries ?? 3;
    const retryDelay = opts?.retryDelayMs ?? 2000;
    const failed: string[] = [];

    await Promise.all(
      agentNames.map(async (agentName) => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const entry = await this.spawnAgent(agentName, opts?.cwd);
            this.pool.set(agentName, entry);
            sessions.set(agentName, entry.acpSessionId);
            console.log(
              `[pool] ${agentName} warm — session ${entry.acpSessionId}`,
            );
            return;
          } catch (err) {
            const msg =
              err instanceof Error
                ? err.message
                : typeof err === "object" && err !== null
                  ? JSON.stringify(err)
                  : String(err);
            if (attempt < maxRetries) {
              console.warn(
                `[pool] ${agentName} failed (attempt ${attempt}/${maxRetries}): ${msg} — retrying in ${retryDelay}ms`,
              );
              await new Promise((r) => setTimeout(r, retryDelay));
            } else {
              console.error(
                `[pool] ${agentName} failed after ${maxRetries} attempts: ${msg}`,
              );
              failed.push(agentName);
            }
          }
        }
      }),
    );

    if (failed.length > 0) {
      console.error(
        `[pool] ${failed.length}/${agentNames.length} agents failed to warm: ${failed.join(", ")}`,
      );
    }

    return sessions;
  }

  private async spawnAgent(
    agentName: string,
    cwd?: string,
  ): Promise<PoolEntry> {
    let active: acp.Client = warmupClient;

    const delegatingClient: acp.Client = {
      async requestPermission(params) {
        return active.requestPermission(params);
      },
      async sessionUpdate(params) {
        return active.sessionUpdate(params);
      },
      async readTextFile(params) {
        return active.readTextFile!(params);
      },
      async writeTextFile(params) {
        return active.writeTextFile!(params);
      },
      async createTerminal(params) {
        return active.createTerminal!(params);
      },
      async terminalOutput(params) {
        return active.terminalOutput!(params);
      },
      async releaseTerminal(params) {
        return active.releaseTerminal!(params);
      },
      async waitForTerminalExit(params) {
        return active.waitForTerminalExit!(params);
      },
      async killTerminal(params) {
        return active.killTerminal!(params);
      },
      async extMethod(method, params) {
        return active.extMethod!(method, params);
      },
      async extNotification(method, params) {
        return active.extNotification!(method, params);
      },
    };

    const result = await this.inner.connect(agentName, delegatingClient);

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

    const session = await result.conn.newSession({
      cwd: cwd ?? process.cwd(),
      mcpServers: [],
    });

    return {
      conn: result.conn,
      acpSessionId: session.sessionId,
      close: result.close,
      setActive: (c) => {
        active = c;
      },
    };
  }

  async connect(
    agentName: string,
    client: acp.Client,
  ): Promise<AgentConnectionResult & { acpSessionId: string }> {
    const entry = this.pool.get(agentName);

    if (!entry) {
      throw new Error(
        `Agent "${agentName}" not in pool. Call warmup() before serve().`,
      );
    }

    // Swap delegate to the caller's handler context
    entry.setActive(client);

    return {
      conn: entry.conn,
      acpSessionId: entry.acpSessionId,
      close: async () => {
        // Per-handler close is a no-op — process stays alive
      },
    };
  }

  /** Get the pre-created ACP session ID for an agent. */
  getSessionId(agentName: string): string | undefined {
    return this.pool.get(agentName)?.acpSessionId;
  }

  /** Kill all agent processes. */
  async shutdown(): Promise<void> {
    const entries = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(entries.map((e) => e.close()));
  }

  /** Kill a specific agent's process. */
  async kill(agentName: string): Promise<void> {
    const entry = this.pool.get(agentName);
    if (entry) {
      this.pool.delete(agentName);
      await entry.close();
    }
  }
}
