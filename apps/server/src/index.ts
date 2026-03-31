import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Flamecast, NodeRuntime, listen } from "@flamecast/sdk";
import type { ISessionService } from "@flamecast/sdk";
import { DockerRuntime } from "@flamecast/runtime-docker";
import { E2BRuntime } from "@flamecast/runtime-e2b";
import { createPsqlStorage } from "@flamecast/storage-psql";
import dotenv from "dotenv";
import { createAgentTemplates } from "./agent-templates.js";

dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent.ts"), "utf8");

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const e2bApiKey = process.env.E2B_API_KEY;
const agentJsBaseUrl = process.env.FLAMECAST_AGENT_JS_BASE_URL;
const agentJsRuntime = agentJsBaseUrl ? new NodeRuntime(agentJsBaseUrl) : null;
const runtimes = {
  default: new NodeRuntime(),
  ...(agentJsRuntime ? { agentjs: agentJsRuntime } : {}),
  docker: new DockerRuntime(),
  ...(e2bApiKey
    ? { e2b: new E2BRuntime({ apiKey: e2bApiKey, template: "flamecast-node22" }) }
    : {}),
};

// ---------------------------------------------------------------------------
// Restate session service — activates automatically when @flamecast/restate
// is installed. Set RESTATE_URL to point at an existing Restate instance
// instead of auto-starting, or RESTATE=off to force in-memory mode.
// ---------------------------------------------------------------------------

let sessionService: ISessionService | undefined;
let restateStop: (() => Promise<void>) | undefined;

if (process.env.RESTATE !== "off") {
  try {
    const { RestateSessionService, autoStartRestate } = await import("@flamecast/restate");
    const restateUrl = process.env.RESTATE_URL;

    if (restateUrl) {
      console.log(`[restate] Connecting to Restate at ${restateUrl}`);
      sessionService = new RestateSessionService(runtimes, restateUrl);
    } else {
      console.log("[restate] Auto-starting Restate server...");
      const restate = await autoStartRestate();
      console.log(`[restate] Ingress: ${restate.ingressUrl}`);
      console.log(`[restate] Admin:   ${restate.adminUrl}`);
      sessionService = new RestateSessionService(runtimes, restate.ingressUrl);
      restateStop = restate.stop;
    }
  } catch {
    // @flamecast/restate not installed — fall back to in-memory
  }
}

// ---------------------------------------------------------------------------
// Flamecast instance
// ---------------------------------------------------------------------------

const flamecast = new Flamecast({
  storage: await createPsqlStorage(url ? { url } : undefined),
  runtimes,
  ...(sessionService ? { sessionService } : {}),
  agentTemplates: createAgentTemplates({
    agentJsEnabled: agentJsRuntime !== null,
    e2bEnabled: Boolean(e2bApiKey),
    hostAgentPath: resolve(__dirname, "../agent.ts"),
    agentSource,
  }),
});

listen(flamecast, { port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
  if (sessionService) {
    console.log(`  Sessions: Restate-backed (durable)`);
  } else {
    console.log(`  Sessions: in-memory`);
  }
});

// Graceful close: tear down in-process resources but leave sessions alive so
// they can be recovered on the next startup via recoverSessions().
async function shutdown() {
  await flamecast.close();
  if (restateStop) {
    console.log("[restate] Stopping Restate server...");
    await restateStop();
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
