import * as acp from "@agentclientprotocol/sdk";
import { StdioTransport } from "@flamecast/acp/transports/stdio";
import { PooledConnectionFactory } from "@flamecast/acp/pool";
import { RegistryConnectionFactory } from "@flamecast/acp/resolver";
import { configureAcp, serve } from "@flamecast/sdk";
import dotenv from "dotenv";

dotenv.config();

const port = parseInt(process.env.PORT ?? "9080", 10);
const agents = (process.env.ACP_AGENTS ?? "claude-acp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 1. Build the pool
const inner = new RegistryConnectionFactory(agents);
const pool = new PooledConnectionFactory(inner);

// 2. Warm — spawn processes, initialize, create sessions
console.log(`Warming agent pool: ${agents.join(", ")}...`);
await pool.warmup(agents);
console.log("Agent pool warm.");

// 3. Wire into VO handlers
configureAcp(pool, {
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

// 4. Serve
serve(port);
console.log(`Restate endpoint listening on :${port}`);

// Graceful shutdown
process.on("SIGINT", () => pool.shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => pool.shutdown().then(() => process.exit(0)));
