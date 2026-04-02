import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { loadRegistry } from "./registry.js";
import { ensureInstalled } from "./installer.js";
import { createProxy } from "./proxy.js";

const registryPath =
  process.argv[2] ?? resolve(import.meta.dirname, "../registry.json");
const port = parseInt(process.env.ACP_GATEWAY_PORT ?? "4000", 10);

console.log(`Loading registry from ${registryPath}...`);
const configs = await loadRegistry(registryPath);

console.log(`Resolved ${configs.length} agents:`);
for (const c of configs) {
  console.log(`  ${c.id} (${c.distribution.type}) — ${c.manifest.name}`);
}

// Install binary agents if needed
for (const config of configs) {
  if (config.distribution.type === "binary") {
    const cmd = await ensureInstalled(config);
    config.distribution.cmd = cmd;
  }
}

const app = createProxy(configs);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ACP Gateway running on http://localhost:${info.port}`);
  console.log(`  GET  /agents       — list agents`);
  console.log(`  POST /runs         — create run`);
  console.log(`  GET  /runs/:id     — run status`);
  console.log(`  GET  /ping         — health check`);
});
