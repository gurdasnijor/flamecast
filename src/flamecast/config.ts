import * as docker from "alchemy/docker";
import { createConnection } from "node:net";
import type { AgentSpawn } from "../shared/connection.js";
import { createDatabase } from "./db/client.js";
import { Flamecast } from "./index.js";
import { getBuiltinAgentPresets, type AgentRuntime } from "./presets.js";
import type { FlamecastStateManager } from "./state-manager.js";
import { MemoryFlamecastStateManager } from "./state-managers/memory/index.js";
import { createPsqlStateManager } from "./state-managers/psql/index.js";
import { findFreePort, openLocalTransport, openTcpTransport } from "./transport.js";
import type { AcpTransport } from "./transport.js";

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
 * Called inside a per-connection Alchemy scope.
 *
 * The provisioner can create Alchemy resources (docker.Container, etc.) inside
 * the scope — those get lifecycle-managed automatically. The transport itself
 * is ephemeral (not persisted). Alchemy persists the resource state (container ID,
 * etc.) for reconnection; the transport is recreated from that state.
 */
export type Provisioner = (
  connectionId: string,
  spec: AgentSpawn,
  runtime: AgentRuntime,
) => Promise<AcpTransport>;

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
    const { db } = await createDatabase(
      typeof config === "object" && "dataDir" in config ? { pgliteDataDir: config.dataDir } : {},
    );
    return createPsqlStateManager(db);
  }
  if (typeof config === "object" && "type" in config) {
    switch (config.type) {
      case "memory":
        return new MemoryFlamecastStateManager();
      case "postgres": {
        process.env.FLAMECAST_POSTGRES_URL = config.url;
        const { db } = await createDatabase();
        return createPsqlStateManager(db);
      }
    }
  }
  // It's a FlamecastStateManager instance
  return config;
}

// ---------------------------------------------------------------------------
// Default provisioner — uses runtime from preset to decide local vs Docker
// ---------------------------------------------------------------------------

function getAlchemyProvider(runtimeType: string): typeof docker {
  switch (runtimeType) {
    case "docker":
      return docker;
    default:
      throw new Error(
        `Unsupported alchemy runtime type: ${JSON.stringify(runtimeType)}. Add a static import and case in getAlchemyProvider().`,
      );
  }
}

const defaultProvisioner: Provisioner = async (connectionId, spec, runtime) => {
  if (runtime.type === "local") {
    return openLocalTransport(spec);
  }

  const provider = getAlchemyProvider(runtime.type);
  const port = await findFreePort();

  // Build image if dockerfile is provided
  if (runtime.image && runtime.dockerfile) {
    await provider.Image(`agent-image-${connectionId}`, {
      name: runtime.image,
      tag: "latest",
      build: { context: ".", dockerfile: runtime.dockerfile },
      skipPush: true,
    });
  }

  await provider.Container(`sandbox-${connectionId}`, {
    image: `${runtime.image}:latest`,
    name: `flamecast-sandbox-${connectionId}`,
    environment: { ACP_PORT: String(port) },
    ports: [{ external: port, internal: port }],
    start: true,
  });

  await waitForAcp("localhost", port);

  return openTcpTransport("localhost", port);
};

/** Wait until the agent actually responds to an ACP initialize, not just port open. */
async function waitForAcp(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host, port }, () => {
          socket.setNoDelay(true);
          const msg =
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              method: "initialize",
              params: { protocolVersion: 1, clientCapabilities: {} },
            }) + "\n";
          socket.once("data", () => {
            socket.destroy();
            resolve();
          });
          socket.write(msg);
          setTimeout(() => {
            socket.destroy();
            reject(new Error("timeout"));
          }, 2000);
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`ACP agent not ready on ${host}:${port} after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createFlamecast(opts: FlamecastOptions = {}): Promise<Flamecast> {
  const stateManager = await resolveStateManager(opts.stateManager);

  const provisioner: Provisioner = opts.provisioner ?? defaultProvisioner;

  const presets = getBuiltinAgentPresets();

  return new Flamecast({ stateManager, provisioner, presets });
}
