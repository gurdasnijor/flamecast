/**
 * Local dev deployment — Docker containers + CF Worker via Alchemy.
 *
 * Uses plain Docker containers for Restate + RuntimeHost (no CF Container
 * binding networking issues in dev). Worker connects via localhost URLs.
 *
 * Usage:
 *   ALCHEMY_PASSWORD=... npx alchemy dev cloudflare.run.dev.ts
 */

import path from "node:path";
import alchemy from "alchemy";
import * as docker from "alchemy/docker";
import { Worker, Vite } from "alchemy/cloudflare";

const app = await alchemy("flamecast-dev", {
  password: process.env.ALCHEMY_PASSWORD,
});

// ─── Restate (Docker container) ─────────────────────────────────────────

const restate = await docker.Container("restate", {
  image: "docker.restate.dev/restatedev/restate:latest",
  name: `flamecast-restate-${app.stage}`,
  ports: [
    { external: 18080, internal: 8080 },  // ingress
    { external: 19070, internal: 9070 },  // admin
  ],
  start: true,
  restart: "unless-stopped",
});

// ─── RuntimeHost (Docker container) ─────────────────────────────────────

const runtimeHostImage = await docker.Image("runtime-host-image", {
  name: "flamecast-runtime-host",
  build: {
    context: ".",
    dockerfile: "deploy/runtime-host/Dockerfile",
  },
});

const runtimeHost = await docker.Container("runtime-host", {
  image: runtimeHostImage,
  name: `flamecast-runtime-host-${app.stage}`,
  ports: [
    { external: 9100, internal: 9100 },
  ],
  environment: {
    RESTATE_INGRESS_URL: "http://host.docker.internal:18080",
    RUNTIME_HOST_PORT: "9100",
  },
  start: true,
  restart: "unless-stopped",
});

// ─── API Worker ─────────────────────────────────────────────────────────

export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./examples/cloudflare/src/dev-app.ts",
  format: "esm",
  compatibility: "node",
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

// ─── Client (Vite SPA) ──────────────────────────────────────────────────

const client = await Vite("flamecast-client", {
  name: `flamecast-client-${app.stage}`,
  cwd: "./apps/client",
  bindings: {},
  dev: {
    command: `PATH=${path.dirname(process.execPath)}:$PATH npx vite dev --port 3000`,
  },
});

console.log(`Restate:      http://localhost:18080 (container: ${restate.id})`);
console.log(`RuntimeHost:  http://localhost:9100 (container: ${runtimeHost.id})`);
console.log(`API:          ${server.url}`);
console.log(`Client:       ${client.url}`);

await app.finalize();
