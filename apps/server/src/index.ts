import { loadRegistryFromIds, type SpawnConfig } from "@flamecast/acp/registry";
import { connectStdio } from "@flamecast/acp/transports/stdio";
import { connectWs } from "@flamecast/acp/transports/websocket";
import { connectHttpSse } from "@flamecast/acp/transports/http-sse";
import { createSessionHost } from "@flamecast/acp/session-host";
import { configureAcp, serve } from "@flamecast/sdk";
import * as acp from "@agentclientprotocol/sdk";
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

// Session hosts for stdio agents — one persistent process per session
const stdioHosts = new Map<string, ReturnType<typeof createSessionHost>>();

function getStdioHost(config: SpawnConfig): ReturnType<typeof createSessionHost> {
  let host = stdioHosts.get(config.id);
  if (!host) {
    const dist = config.distribution;
    host = createSessionHost(dist.cmd, dist.args, {
      ...(dist.type === "npx" ? dist.env : undefined),
      ...config.env,
    });
    stdioHosts.set(config.id, host);
  }
  return host;
}

function resolveAgent(
  name: string,
  sessionId: string,
  toClient: (agent: acp.Agent) => acp.Client,
) {
  const config = configMap.get(name);
  if (!config) throw new Error(`Unknown agent: ${name}`);

  const dist = config.distribution;

  // Remote agents — fresh connection per handler
  if (dist.type === "url") {
    const url = dist.url;
    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      return connectWs({ url }, toClient);
    }
    return connectHttpSse({ url }, toClient);
  }

  // Stdio agents — persistent process per session
  const host = getStdioHost(config);
  const session = host.getOrCreate(sessionId);
  return new acp.ClientSideConnection(toClient, session.stream);
}

configureAcp({ resolveAgent }, {
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

serve(port);
console.log(`Restate endpoint listening on :${port}`);
console.log(`Agents: ${agents.join(", ")}`);

process.on("SIGINT", async () => {
  for (const host of stdioHosts.values()) await host.closeAll();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  for (const host of stdioHosts.values()) await host.closeAll();
  process.exit(0);
});
