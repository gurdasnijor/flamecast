/**
 * Agent backend — provides a ClientSideConnection to an agent.
 *
 * Fetches agent configs from the ACP CDN registry, caches locally.
 * No filesystem path dependencies across packages.
 */

import * as acp from "@agentclientprotocol/sdk";
import { StdioTransport } from "@flamecast/acp-gateway/transports/stdio";
import {
  loadRegistryFromIds,
  type SpawnConfig,
} from "@flamecast/acp-gateway/registry";
import type { TransportConnection } from "@flamecast/acp-gateway/transport";

// ─── Interface ──────────────────────────────────────────────────────────────

export interface AgentConnection {
  conn: acp.ClientSideConnection;
  sessionId: string;
  transport: TransportConnection;
}

export interface AgentBackend {
  connect(
    agentName: string,
    runId: string,
    client: acp.Client,
    cwd?: string,
  ): Promise<AgentConnection>;

  listAgents(): Promise<Array<{ name: string; description?: string }>>;
}

// ─── Stdio Backend ──────────────────────────────────────────────────────────

export class StdioBackend implements AgentBackend {
  private transport = new StdioTransport();
  private configs: Map<string, SpawnConfig> = new Map();
  private initialized = false;

  constructor(private agentIds: string[]) {}

  private async ensureInit() {
    if (this.initialized) return;
    const configs = await loadRegistryFromIds(this.agentIds);
    for (const c of configs) {
      this.configs.set(c.id, c);
      this.configs.set(c.manifest.name, c);
    }
    this.initialized = true;
  }

  async listAgents() {
    await this.ensureInit();
    return [...new Set(this.configs.values())].map((c) => ({
      name: c.id,
      description: c.manifest.description,
    }));
  }

  async connect(
    agentName: string,
    runId: string,
    client: acp.Client,
    cwd?: string,
  ): Promise<AgentConnection> {
    await this.ensureInit();
    const config = this.configs.get(agentName);
    if (!config) throw new Error(`Unknown agent: ${agentName}`);

    const resolvedCwd = cwd ?? process.cwd();
    const transport = await this.transport.connect(config, runId, resolvedCwd);
    const conn = new acp.ClientSideConnection((_agent) => client, transport.stream);

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "flamecast", title: "Flamecast", version: "1.0.0" },
    });

    const session = await conn.newSession({
      cwd: resolvedCwd,
      mcpServers: [],
    });

    return { conn, sessionId: session.sessionId, transport };
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createBackend(): AgentBackend {
  const agentIds = (process.env.ACP_AGENTS ?? "claude-acp").split(",").map((s) => s.trim()).filter(Boolean);
  return new StdioBackend(agentIds);
}
