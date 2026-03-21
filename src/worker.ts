import { Hono } from "hono";
import { getContainer } from "@cloudflare/containers";
import { Flamecast } from "./flamecast/index.js";
import { createApi } from "./flamecast/api.js";
import { MemoryFlamecastStateManager } from "./flamecast/state-managers/memory/index.js";
import { getBuiltinAgentPresets } from "./flamecast/presets.js";
import { openTcpTransport } from "./flamecast/transport.js";
import type { server } from "../alchemy.run";

// Must re-export the Container DO class for Cloudflare
export { AgentContainer } from "./agent-container";

type Env = typeof server.Env;

const app = new Hono<{ Bindings: Env }>();

let flamecast: Flamecast | null = null;

function getFlamecast(env: Env): Flamecast {
  if (!flamecast) {
    flamecast = new Flamecast({
      stateManager: new MemoryFlamecastStateManager(),
      provisioner: async (connectionId) => {
        const container = getContainer(env.AGENT_CONTAINER, connectionId);
        await container.start();
        const port = 9100;
        const host = `localhost`;
        return openTcpTransport(host, port);
      },
      presets: getBuiltinAgentPresets(),
    });
  }
  return flamecast;
}

app.all("/api/*", async (c) => {
  const fc = getFlamecast(c.env);
  const apiRoutes = createApi(fc);
  const handler = new Hono();
  handler.route("/api", apiRoutes);
  return handler.fetch(c.req.raw);
});

export default app;
