/**
 * Cloudflare deployment — full stack via Alchemy.
 *
 * Deploys:
 *   1. Restate server        → CF Container (via Worker binding)
 *   2. RuntimeHost server     → CF Container (via Worker binding)
 *   3. Flamecast API          → CF Worker (stateless HTTP)
 *
 * Usage:
 *   ALCHEMY_PASSWORD=... npx alchemy dev cloudflare.run.ts
 *
 * Required env:
 *   ALCHEMY_PASSWORD       — Alchemy state encryption key
 *   CLOUDFLARE_API_TOKEN   — CF API token with Workers + Containers permissions
 *   CLOUDFLARE_ACCOUNT_ID  — CF account ID
 */

import alchemy from "alchemy";
import { Container, Worker } from "alchemy/cloudflare";
import { Image } from "alchemy/docker";

const app = await alchemy("flamecast", {
  password: process.env.ALCHEMY_PASSWORD,
});

// ─── Container images ───────────────────────────────────────────────────

// Restate: pre-built image from official registry
const restateImage = await Image("restate-image", {
  image: "docker.restate.dev/restatedev/restate:latest",
});

// RuntimeHost: built from our Dockerfile
const runtimeHostImage = await Image("runtime-host-image", {
  name: "flamecast-runtime-host",
  build: {
    context: ".",
    dockerfile: "deploy/runtime-host/Dockerfile",
    platform: "linux/amd64",
  },
});

// ─── API Worker with Container bindings ─────────────────────────────────
// Container bindings handle registry push + container creation automatically.

const api = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./examples/cloudflare/src/app.ts",
  format: "esm",
  compatibility: "node",
  bindings: {
    RESTATE: await Container("restate", {
      className: "RestateServer",
      image: restateImage,
      maxInstances: 1,
      instanceType: "basic",
    }),
    RUNTIME_HOST: await Container("runtime-host", {
      className: "RuntimeHostServer",
      image: runtimeHostImage,
      maxInstances: 3,
      instanceType: "basic",
    }),
    RESTATE_INGRESS_URL: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
    FLAMECAST_RUNTIME_HOST: "remote",
    FLAMECAST_RUNTIME_HOST_URL: process.env.FLAMECAST_RUNTIME_HOST_URL ?? "http://localhost:9100",
  },
  url: true,
});

console.log(`API: ${api.url}`);

await app.finalize();
