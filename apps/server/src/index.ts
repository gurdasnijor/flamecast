import {
  PooledConnectionFactory,
  RegistryConnectionFactory,
  configureAcp,
  serve,
} from "@flamecast/sdk";
import dotenv from "dotenv";

dotenv.config();

const port = parseInt(process.env.PORT ?? "9080", 10);
const agents = (process.env.ACP_AGENTS ?? "claude-acp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 1. Build the pool + wire into handlers
const inner = new RegistryConnectionFactory(agents);
const pool = new PooledConnectionFactory(inner);
configureAcp(pool, {
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

// 2. Start serving FIRST — Restate needs the endpoint to be up for registration
serve(port);
console.log(`Restate endpoint listening on :${port}`);

// 3. Warm agents in the background — handlers that need warm agents
//    will fail until this completes, but discovery + registration work immediately
console.log(`Warming agent pool: ${agents.join(", ")}...`);
pool.warmup(agents).then((sessions) => {
  console.log(`Agent pool warm — ${sessions.size}/${agents.length} agents ready.`);
}).catch((err) => {
  console.error("Agent pool warmup failed:", err);
});

// Graceful shutdown
process.on("SIGINT", () => pool.shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => pool.shutdown().then(() => process.exit(0)));
