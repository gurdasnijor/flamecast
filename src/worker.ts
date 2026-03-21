import { Hono } from "hono";
import { Flamecast } from "./flamecast/index.js";
import { createApi } from "./flamecast/api.js";
import { MemoryFlamecastStateManager } from "./flamecast/state-managers/memory/index.js";
import { getBuiltinAgentPresets } from "./flamecast/presets.js";
import { openTcpTransport } from "./flamecast/transport.js";
import type { server } from "../alchemy.run";
import type { AgentContainer } from "./agent-container";

export { AgentContainer } from "./agent-container";

type Env = typeof server.Env;

const app = new Hono<{ Bindings: Env }>();

// Lazy init — create Flamecast with a provisioner that uses the Container binding
let flamecast: Flamecast | null = null;

function getFlamecast(env: Env): Flamecast {
  if (!flamecast) {
    flamecast = new Flamecast({
      stateManager: new MemoryFlamecastStateManager(),
      provisioner: async (connectionId) => {
        // Get a Container DO instance for this connection
        const id = env.AGENT_CONTAINER.idFromName(connectionId);
        const container = env.AGENT_CONTAINER.get(id) as DurableObjectStub<AgentContainer>;

        // Start the container and wait for the ACP port
        await container.start();
        const { host, port } = await container.startAndWaitForPorts();

        return openTcpTransport(host, port);
      },
      presets: getBuiltinAgentPresets(),
    });
  }
  return flamecast;
}

app.all("/api/*", async (c) => {
  const fc = getFlamecast(c.env);
  const api = createApi(fc);
  const subApp = new Hono();
  subApp.route("/api", api);
  return subApp.fetch(c.req.raw);
});

export default app;
