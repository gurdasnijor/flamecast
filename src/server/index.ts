import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApi } from "./api.js";
import { loadServerConfig } from "./config.js";
import { createPsqlProjection } from "../flamecast/projections/psql/index.js";
import { MemoryFlamecastProjection } from "../flamecast/projections/memory/index.js";
import { createDatabase } from "./db/client.js";
import { Flamecast } from "../flamecast/index.js";

const serverConfig = await loadServerConfig();
const projection =
  serverConfig.projection === "memory"
    ? new MemoryFlamecastProjection()
    : createPsqlProjection((await createDatabase()).db);
const flamecast = new Flamecast({ projection });
const api = createApi(flamecast);

const app = new Hono();

app.route("/api", api);

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`🔥 API server running on http://localhost:${info.port}`);
});
