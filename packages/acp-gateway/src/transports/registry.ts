/**
 * Registry transport — resolves agent names via the ACP CDN registry,
 * then delegates to StdioTransport.
 *
 * This bridges the gap between AcpClient (which connects by agent name)
 * and StdioTransport (which needs cmd + args).
 *
 *   const transport = new RegistryTransport(["claude-acp", "codex-acp"]);
 *   const client = new AcpClient({ transport });
 *   await client.connect("claude-acp");
 */

import { loadRegistryFromIds, type SpawnConfig } from "../registry.js";
import type { Transport, TransportConnection } from "../transport.js";
import { StdioTransport } from "./stdio.js";

export interface RegistryConnectOptions {
  agentName: string;
  /** Override cwd for the spawned process. */
  cwd?: string;
  /** Extra env vars merged on top of registry defaults. */
  env?: Record<string, string>;
}

export class RegistryTransport implements Transport<RegistryConnectOptions> {
  private stdio = new StdioTransport();
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

  async connect(opts: RegistryConnectOptions): Promise<TransportConnection> {
    const configs = await this.ensureInit();
    const config = configs.get(opts.agentName);
    if (!config) {
      throw new Error(`Unknown agent: ${opts.agentName}`);
    }

    const dist = config.distribution;
    if (dist.type === "url") {
      throw new Error(
        `Agent "${opts.agentName}" has url distribution — use an HTTP transport instead`,
      );
    }

    return this.stdio.connect({
      cmd: dist.cmd,
      args: dist.args,
      cwd: opts.cwd,
      env: {
        ...(dist.type === "npx" ? dist.env : undefined),
        ...config.env,
        ...opts.env,
      },
      label: opts.agentName,
    });
  }
}
