import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { Flamecast } from "./flamecast/index.js";
import { createApi } from "./flamecast/api.js";
import { MemoryFlamecastStateManager } from "./flamecast/state-managers/memory/index.js";
import type { server } from "../alchemy.run";

const flamecast = new Flamecast({
  stateManager: new MemoryFlamecastStateManager(),
  provisioner: async (_id, spec) => {
    const { openLocalTransport } = await import("./flamecast/transport.js");
    return openLocalTransport(spec);
  },
  // No alchemyScope — alchemy runs at deploy time, not inside the Worker
});

const app = new Hono();
app.route("/api", createApi(flamecast));

export default app;
