/**
 * Agent backend — provides a ClientSideConnection to an agent.
 *
 * The VO handles everything else (pubsub, awakeables, state).
 * The backend just connects to the agent via the appropriate transport.
 *
 *   ACP_BACKEND=stdio    → spawn agent process, wire stdio (local dev)
 *   ACP_BACKEND=gateway  → connect to remote gateway (edge/cloud)
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
import { StdioTransport } from "@flamecast/acp-gateway/transports/stdio";
import {
  loadRegistry,
  type SpawnConfig,
} from "@flamecast/acp-gateway/registry";
import type { TransportConnection } from "@flamecast/acp-gateway/transport";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRegistry(): string {
  if (process.env.ACP_REGISTRY_PATH) return process.env.ACP_REGISTRY_PATH;

  // Try relative to this file (packages/flamecast/src/acp/ → packages/acp-gateway/)
  const fromSrc = resolve(__dirname, "../../../acp-gateway/registry.json");
  if (existsSync(fromSrc)) return fromSrc;

  // Try relative to CWD (monorepo root)
  const fromCwd = resolve(process.cwd(), "packages/acp-gateway/registry.json");
  if (existsSync(fromCwd)) return fromCwd;

  return "./registry.json";
}

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

  constructor(private registryPath?: string) {}

  private async ensureInit() {
    if (this.initialized) return;
    const path = this.registryPath ?? findRegistry();
    try {
      console.log(`[StdioBackend] Loading registry from ${path}`);
      const configs = await loadRegistry(path);
      console.log(`[StdioBackend] Loaded ${configs.length} agents`);
      for (const c of configs) {
        this.configs.set(c.id, c);
        this.configs.set(c.manifest.name, c);
      }
    } catch (err) {
      console.error(`[StdioBackend] Failed to load registry from ${path}:`, err);
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
  // Future: ACP_BACKEND=gateway → GatewayBackend
  return new StdioBackend();
}
