import { Hono } from "hono";
import { Flamecast } from "./flamecast/index.js";
import { createApi } from "./flamecast/api.js";
import { MemoryFlamecastStateManager } from "./flamecast/state-managers/memory/index.js";
import { getBuiltinAgentPresets } from "./flamecast/presets.js";
import { openLocalTransport } from "./flamecast/transport.js";

const flamecast = new Flamecast({
  stateManager: new MemoryFlamecastStateManager(),
  provisioner: async (_id, spec) => openLocalTransport(spec),
  presets: getBuiltinAgentPresets(),
});

const app = new Hono();
app.route("/api", createApi(flamecast));

export default app;
