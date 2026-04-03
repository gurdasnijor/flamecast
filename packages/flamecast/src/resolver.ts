/**
 * RegistryConnectionFactory — resolves agent names from the ACP CDN
 * registry and connects via the appropriate transport.
 *
 * Distribution type → transport:
 *   npx / binary / uvx → connectStdio
 *   url (ws://)        → connectWs
 *   url (http://)      → connectHttpSse
 */

import * as acp from "@agentclientprotocol/sdk";
import type { AgentConnectionFactory, AgentConnectionResult } from "./factory.js";
import { loadRegistryFromIds, type SpawnConfig } from "@flamecast/acp/registry";
import { applyCodec, ndJsonCodec, jsonCodec } from "@flamecast/acp/transport";
import { connectStdio } from "@flamecast/acp/transports/stdio";
import { connectWs } from "@flamecast/acp/transports/websocket";
import { connectHttpSse } from "@flamecast/acp/transports/http-sse";

export type { AgentConnectionFactory };

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
    let stream: acp.Stream & { close: () => Promise<void>; signal: AbortSignal };

    if (dist.type === "url") {
      const url = dist.url;
      if (url.startsWith("ws://") || url.startsWith("wss://")) {
        const bytes = await connectWs({ url });
        stream = applyCodec(bytes, jsonCodec());
      } else {
        const bytes = await connectHttpSse({ url });
        stream = applyCodec(bytes, jsonCodec());
      }
    } else {
      const bytes = await connectStdio({
        cmd: dist.cmd,
        args: dist.args,
        env: {
          ...(dist.type === "npx" ? dist.env : undefined),
          ...config.env,
        },
        label: agentName,
      });
      stream = applyCodec(bytes, ndJsonCodec());
    }

    const conn = new acp.ClientSideConnection(() => client, stream);

    return {
      conn,
      close: () => stream.close(),
    };
  }
}
