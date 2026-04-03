import { loadRegistryFromIds, type SpawnConfig } from "@flamecast/acp/registry";
import { connectStdio } from "@flamecast/acp/transports/stdio";
import { connectWs } from "@flamecast/acp/transports/websocket";
import { connectHttpSse } from "@flamecast/acp/transports/http-sse";
import { configureAcp, serve } from "@flamecast/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import dotenv from "dotenv";

dotenv.config();

const port = parseInt(process.env.PORT ?? "9080", 10);
const agents = (process.env.ACP_AGENTS ?? "claude-acp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const configs = await loadRegistryFromIds(agents);
const configMap = new Map<string, SpawnConfig>();
for (const c of configs) {
  configMap.set(c.id, c);
  configMap.set(c.manifest.name, c);
}

function resolveAgent(
  name: string,
  clientFactory: (agent: acp.Agent) => acp.Client,
) {
  const config = configMap.get(name);
  if (!config) throw new Error(`Unknown agent: ${name}`);

  const dist = config.distribution;
  if (dist.type === "url") {
    const url = dist.url;
    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      return connectWs({ url }, clientFactory);
    }
    return connectHttpSse({ url }, clientFactory);
  }

  return connectStdio(
    {
      cmd: dist.cmd,
      args: dist.args,
      env: {
        ...(dist.type === "npx" ? dist.env : undefined),
        ...config.env,
      },
      label: name,
    },
    clientFactory,
  );
}

configureAcp({ resolveAgent }, {
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

serve(port);
console.log(`Restate endpoint listening on :${port}`);
console.log(`Agents: ${agents.join(", ")}`);
