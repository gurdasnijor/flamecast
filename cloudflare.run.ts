/**
 * Cloudflare deployment — full stack via Alchemy.
 *
 * Deploys:
 *   1. Restate server        → CF Container (durable state)
 *   2. RuntimeHost server     → CF Container (agent processes)
 *   3. Flamecast API          → CF Worker (stateless HTTP)
 *
 * Usage:
 *   ALCHEMY_PASSWORD=... npx alchemy run cloudflare.run.ts
 *
 * Required env:
 *   ALCHEMY_PASSWORD    — Alchemy state encryption key
 *   CLOUDFLARE_API_TOKEN — CF API token with Workers + Containers permissions
 */

import alchemy from "alchemy";
import {
  ContainerApplication,
  Worker,
} from "alchemy/cloudflare";
import { Image } from "alchemy/docker";

const app = await alchemy("flamecast", {
  password: process.env.ALCHEMY_PASSWORD,
});

// ─── Restate server (durable state engine) ──────────────────────────────

const restateImage = await Image("restate-image", {
  name: `flamecast-restate-${app.stage}`,
  imageUri: "docker.restate.dev/restatedev/restate:latest",
  skipPush: false,
});

const restate = await ContainerApplication("restate", {
  name: `flamecast-restate-${app.stage}`,
  image: restateImage,
  instances: 1,
  maxInstances: 1,
  instanceType: "basic", // 1/4 vCPU, 1-4 GB RAM
  observability: { logs: { enabled: true } },
});

// ─── RuntimeHost server (agent process manager) ─────────────────────────

const runtimeHostImage = await Image("runtime-host-image", {
  name: `flamecast-runtime-host-${app.stage}`,
  build: {
    context: ".",
    dockerfile: "deploy/runtime-host/Dockerfile",
  },
});

const runtimeHost = await ContainerApplication("runtime-host", {
  name: `flamecast-runtime-host-${app.stage}`,
  image: runtimeHostImage,
  instances: 1,
  maxInstances: 3,
  instanceType: "basic",
  observability: { logs: { enabled: true } },
});

// ─── API Worker (stateless HTTP) ────────────────────────────────────────

const api = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./examples/cloudflare/src/worker.ts",
  format: "esm",
  compatibility: "node",
  bindings: {
    // Container networking: Restate and RuntimeHost URLs are configured
    // via environment variables. In production, use CF internal networking
    // or public container endpoints.
    RESTATE_INGRESS_URL: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
    FLAMECAST_RUNTIME_HOST: "remote",
    FLAMECAST_RUNTIME_HOST_URL: process.env.FLAMECAST_RUNTIME_HOST_URL ?? "http://localhost:9100",
  },
  url: true,
});

console.log(`API:          ${api.url}`);
console.log(`Restate:      ${restate.id}`);
console.log(`RuntimeHost:  ${runtimeHost.id}`);

await app.finalize();
