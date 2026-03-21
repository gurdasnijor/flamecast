import alchemy from "alchemy";
import { Worker, Vite } from "alchemy/cloudflare";
import * as docker from "alchemy/docker";

const app = await alchemy("flamecast-infra");

// ---------------------------------------------------------------------------
// Database — Postgres in Docker
// ---------------------------------------------------------------------------

const db = await docker.Container("flamecast-db", {
  adopt: true,
  image: "postgres:16",
  name: `flamecast-db-${app.stage}`,
  environment: {
    POSTGRES_USER: "flamecast",
    POSTGRES_PASSWORD: "flamecast",
    POSTGRES_DB: "flamecast",
  },
  ports: [{ external: 5432, internal: 5432 }],
  restart: "unless-stopped",
  start: true,
});

const DATABASE_URL = `postgres://flamecast:flamecast@localhost:5432/flamecast`;

// ---------------------------------------------------------------------------
// Agent containers
// ---------------------------------------------------------------------------

const ACP_PORT = 9100;

const exampleAgentImage = await docker.Image("example-agent-image", {
  name: "flamecast/example-agent",
  tag: app.stage,
  build: { context: ".", dockerfile: "docker/example-agent.Dockerfile" },
  skipPush: true,
});

const exampleAgent = await docker.Container("example-agent", {
  adopt: true,
  image: exampleAgentImage,
  name: `flamecast-example-agent-${app.stage}`,
  environment: { ACP_PORT: String(ACP_PORT) },
  ports: [{ external: ACP_PORT, internal: ACP_PORT }],
  restart: "unless-stopped",
  start: true,
});

// ---------------------------------------------------------------------------
// API server
// ---------------------------------------------------------------------------

export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./src/worker.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    DATABASE_URL,
  },
  url: true,
  dev: {
    port: 3001,
  },
  bundle: {
    external: ["npm-run-path", "unicorn-magic", "execa"],
  },
});

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

export const client = await Vite("flamecast-client", {
  name: `flamecast-client-${app.stage}`,
  bindings: {
    VITE_API_URL: Worker.DevUrl,
  },
});

console.log(`API: ${server.url}`);

await app.finalize();

export { db };
