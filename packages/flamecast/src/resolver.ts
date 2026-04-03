/**
 * RegistryConnectionFactory — resolves agent names from the ACP CDN
 * registry and connects via the appropriate transport.
 *
 * Distribution type → transport:
 *   npx / binary / uvx → StdioTransport
 *   url (ws://)        → WsTransport
 *   url (http://)      → HttpSseTransport
 */

import * as acp from "@agentclientprotocol/sdk";
import type { AgentConnectionFactory, AgentConnectionResult } from "./factory.js";
import { loadRegistryFromIds, type SpawnConfig } from "@flamecast/acp/registry";
import { StdioTransport } from "@flamecast/acp/transports/stdio";
import { WsTransport } from "@flamecast/acp/transports/websocket";
import { HttpSseTransport } from "@flamecast/acp/transports/http-sse";

export type { AgentConnectionFactory };

const stdioTransport = new StdioTransport();
const wsTransport = new WsTransport();
const httpSseTransport = new HttpSseTransport();

export class RegistryConnectionFactory implements AgentConnectionFactory {
  private configs: Map<string, SpawnConfig> | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private agentIds: string[]) {}

  private async ensureInit(): Promise<Map<string, SpawnConfig>> {
    if (this.configs) return this.configs;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const configs = await loadRegistryFromIds(this.agentIds);
        const map = new Map<string, SpawnConfig>();
        for (const c of configs) {
          map.set(c.id, c);
          map.set(c.manifest.name, c);
        }
        this.configs = map;
      })();
    }
    await this.initPromise;
    return this.configs!;
  }

  async connect(
    agentName: string,
    client: acp.Client,
  ): Promise<AgentConnectionResult> {
    const configs = await this.ensureInit();
    const config = configs.get(agentName);
    if (!config) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    const dist = config.distribution;
    let connection;

    if (dist.type === "url") {
      const url = dist.url;
      if (url.startsWith("ws://") || url.startsWith("wss://")) {
        connection = await wsTransport.connect({ url });
      } else {
        connection = await httpSseTransport.connect({ url });
      }
    } else {
      connection = await stdioTransport.connect({
        cmd: dist.cmd,
        args: dist.args,
        env: {
          ...(dist.type === "npx" ? dist.env : undefined),
          ...config.env,
        },
        label: agentName,
      });
    }

    const conn = new acp.ClientSideConnection(() => client, connection.stream);

    return {
      conn,
      close: () => connection.close(),
    };
  }
}
