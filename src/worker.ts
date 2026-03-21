import { Hono } from "hono";
import { Flamecast } from "./flamecast/index.js";
import { createApi } from "./flamecast/api.js";
import { MemoryFlamecastStateManager } from "./flamecast/state-managers/memory/index.js";

const flamecast = new Flamecast({
  stateManager: new MemoryFlamecastStateManager(),
  provisioner: async () => {
    throw new Error("Agent provisioning not available in Worker — configure a remote provisioner");
  },
});

const app = new Hono();
app.route("/api", createApi(flamecast));

export default app;
