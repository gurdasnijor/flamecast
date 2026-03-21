import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { createFlamecast } from "./flamecast/config.js";
import { createApi } from "./flamecast/api.js";
import type { server } from "../alchemy.run";

const app = new Hono();

const flamecast = await createFlamecast({
  // TODO: D1 state manager using env.DB
  stateManager: { type: "memory" },
});

app.route("/api", createApi(flamecast));

export default app;
