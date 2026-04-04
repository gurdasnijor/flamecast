import { fetchAgentConfigs, registerAgent, serve } from "@flamecast/sdk";
import dotenv from "dotenv";

dotenv.config();

const port = parseInt(process.env.PORT ?? "9080", 10);
const agentIds = (process.env.ACP_AGENTS ?? "claude-acp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Load agent configs from CDN and register them
const configs = await fetchAgentConfigs(agentIds);
for (const [id, config] of configs) registerAgent(id, config);

serve(port);
console.log(`Restate endpoint listening on :${port}`);
console.log(`Agents: ${agentIds.join(", ")}`);
