import alchemy from "alchemy";
import type { FlamecastStateManager } from "./state-manager.js";
import { MemoryFlamecastStateManager } from "./state-managers/memory/index.js";
import { Flamecast } from "./index.js";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type StateManagerConfig =
  | { type: "memory" }
  | { type: "pglite"; dataDir?: string }
  | { type: "postgres"; url: string }
  | FlamecastStateManager; // pass your own implementation

/**
 * Provisioner — a function that creates an agent and returns an AcpTransport.
 * Called inside a per-connection Alchemy scope. The transport is how Flamecast
 * communicates with the agent (stdio streams, TCP socket, RPC, etc.).
 *
 * Implementations:
 * - Local: spawn ChildProcess, return stdio streams
 * - Docker: create container via alchemy/docker, connect TCP, return streams
 * - Cloudflare: create Container resource, return RPC-backed streams
 *
 * Alchemy handles create/update/delete lifecycle automatically via scopes.
 */
export type Provisioner = (
  connectionId: string,
  spec: import("../shared/connection.js").AgentSpawn,
) => Promise<import("./transport.js").AcpTransport>;

export type FlamecastOptions = {
  stateManager?: StateManagerConfig; // default: { type: "pglite" }
  /** Provisioner that creates agents and returns an AcpTransport. Defaults to local ChildProcess. */
  provisioner?: Provisioner;
  /** Alchemy stage for resource isolation. Defaults to $USER. */
  stage?: string;
};

// ---------------------------------------------------------------------------
// Config → instance resolvers
// ---------------------------------------------------------------------------

async function resolveStateManager(config?: StateManagerConfig): Promise<FlamecastStateManager> {
  if (!config || (typeof config === "object" && "type" in config && config.type === "pglite")) {
    const { createDatabase } = await import("./db/client.js");
    const { db } = await createDatabase(
      typeof config === "object" && "dataDir" in config ? { pgliteDataDir: config.dataDir } : {},
    );
    const { createPsqlStateManager } = await import("./state-managers/psql/index.js");
    return createPsqlStateManager(db);
  }
  if (typeof config === "object" && "type" in config) {
    switch (config.type) {
      case "memory":
        return new MemoryFlamecastStateManager();
      case "postgres": {
        const { createDatabase } = await import("./db/client.js");
        process.env.FLAMECAST_POSTGRES_URL = config.url;
        const { db } = await createDatabase();
        const { createPsqlStateManager } = await import("./state-managers/psql/index.js");
        return createPsqlStateManager(db);
      }
    }
  }
  // It's a FlamecastStateManager instance
  return config;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Flamecast instance from config options.
 * Resolves state manager, initializes Alchemy when a provisioner is provided.
 */
export async function createFlamecast(opts: FlamecastOptions = {}): Promise<Flamecast> {
  const stateManager = await resolveStateManager(opts.stateManager);

  await alchemy("flamecast", { stage: opts.stage });

  // Default provisioner: local ChildProcess via stdio
  const provisioner: Provisioner =
    opts.provisioner ??
    (async (_connectionId, spec) => {
      const { openLocalTransport } = await import("./transport.js");
      return openLocalTransport(spec);
    });

  return new Flamecast({ stateManager, provisioner });
}
