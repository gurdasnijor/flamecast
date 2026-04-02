/**
 * Cloudflare deployment — full stack via Alchemy.
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
import { Container, Vite } from "alchemy/cloudflare";
import type { RestateServer, RuntimeHostServer } from "./examples/cloudflare/src/app.ts";

const app = await alchemy("flamecast", {
  password: process.env.ALCHEMY_PASSWORD,
});

const restateContainer = await Container<RestateServer>("restate", {
  className: "RestateServer",
  image: "docker.restate.dev/restatedev/restate:latest",
  maxInstances: 1,
  instanceType: "basic",
});

const runtimeHostContainer = await Container<RuntimeHostServer>("runtime-host", {
  className: "RuntimeHostServer",
  build: {
    context: ".",
    dockerfile: "deploy/runtime-host/Dockerfile",
  },
  maxInstances: 3,
  instanceType: "basic",
});

export const website = await Vite("flamecast", {
  name: `flamecast-${app.stage}`,
  entrypoint: "./examples/cloudflare/src/app.ts",
  bindings: {
    RESTATE: restateContainer,
    RUNTIME_HOST: runtimeHostContainer,
  },
});

console.log(`URL: ${website.url}`);

await app.finalize();
