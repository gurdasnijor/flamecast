import path from "node:path";
import alchemy from "alchemy";
import * as docker from "alchemy/docker";
import { Exec } from "alchemy/os";
import { Worker, Vite } from "alchemy/cloudflare";

const app = await alchemy("flamecast-dev", {
  password: process.env.ALCHEMY_PASSWORD,
});

const network = await docker.Network("flamecast-network", {
  name: `flamecast-network-${app.stage}`,
});

// Shared image — same build, different CMD per container
const flamecastImage = await docker.Image("flamecast-image", {
  name: "flamecast",
  build: {
    context: ".",
    dockerfile: "deploy/runtime-host/Dockerfile",
  },
});

// ─── Restate server ─────────────────────────────────────────────────────

const restate = await docker.Container("restate", {
  image: "docker.restate.dev/restatedev/restate:latest",
  name: `flamecast-restate-${app.stage}`,
  ports: [
    { external: 18080, internal: 8080 },
    { external: 19070, internal: 9070 },
  ],
  networks: [{ name: network.name }],
  start: true,
  restart: "unless-stopped",
});

// ─── Service endpoint (Restate VOs: AgentSession + pubsub) ──────────────

const endpoint = await docker.Container("endpoint", {
  image: flamecastImage,
  name: `flamecast-endpoint-${app.stage}`,
  ports: [{ external: 9080, internal: 9080 }],
  networks: [{ name: network.name }],
  environment: {
    FLAMECAST_RUNTIME_HOST: "remote",
    FLAMECAST_RUNTIME_HOST_URL: `http://flamecast-runtime-host-${app.stage}:9100`,
    RESTATE_INGRESS_URL: `http://flamecast-restate-${app.stage}:8080`,
  },
  command: ["node", "packages/flamecast/dist/restate/serve-endpoint.js"],
  start: true,
  restart: "unless-stopped",
});

// ─── RuntimeHost (spawns agent processes) ───────────────────────────────

const runtimeHost = await docker.Container("runtime-host", {
  image: flamecastImage,
  name: `flamecast-runtime-host-${app.stage}`,
  ports: [{ external: 9100, internal: 9100 }],
  networks: [{ name: network.name }],
  environment: {
    RESTATE_INGRESS_URL: `http://flamecast-restate-${app.stage}:8080`,
    RUNTIME_HOST_PORT: "9100",
    ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
    ...(process.env.OPENAI_API_KEY && { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
    ...(process.env.GOOGLE_API_KEY && { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY }),
    ...(process.env.GITHUB_TOKEN && { GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
  },
  volumes: [
    // Docker socket so RuntimeHost can spawn agent containers
    { hostPath: "/var/run/docker.sock", containerPath: "/var/run/docker.sock" },
  ],
  start: true,
  restart: "unless-stopped",
});

// ─── Register endpoint with Restate ─────────────────────────────────────

const endpointUrl = `http://flamecast-endpoint-${app.stage}:9080`;
await Exec("register-endpoint", {
  command: `for i in $(seq 1 15); do curl -sf -X POST http://localhost:19070/deployments -H "Content-Type: application/json" -d '{"uri":"${endpointUrl}","force":true}' && exit 0; sleep 2; done; exit 1`,
});

// ─── API Worker ─────────────────────────────────────────────────────────

export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./examples/cloudflare/src/dev-app.ts",
  format: "esm",
  compatibility: "node",
  noBundle: true,
  bindings: {
    RESTATE_INGRESS_URL: "http://localhost:18080",
    FLAMECAST_RUNTIME_HOST: "remote",
    FLAMECAST_RUNTIME_HOST_URL: "http://localhost:9100",
  },
  url: true,
  dev: {
    port: 3001,
  },
});

// ─── Client ─────────────────────────────────────────────────────────────

const client = await Vite("flamecast-client", {
  name: `flamecast-client-${app.stage}`,
  cwd: "./apps/client",
  bindings: {},
  dev: {
    command: `PATH=${path.dirname(process.execPath)}:$PATH npx vite dev --port 3000`,
  },
});

console.log(`Restate:      http://localhost:18080`);
console.log(`Endpoint:     http://localhost:9080`);
console.log(`RuntimeHost:  http://localhost:9100`);
console.log(`API:          ${server.url}`);
console.log(`Client:       ${client.url}`);

await app.finalize();
