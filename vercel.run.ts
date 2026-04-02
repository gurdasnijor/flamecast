/**
 * Vercel deployment — API server via Alchemy.
 *
 * Deploys the Flamecast API as a Vercel Function. Restate and RuntimeHost
 * must be hosted separately (CF Containers, Fly.io, self-hosted, etc.)
 * and configured via environment variables.
 *
 * Usage:
 *   ALCHEMY_PASSWORD=... npx alchemy run vercel.run.ts
 *
 * Required env:
 *   ALCHEMY_PASSWORD       — Alchemy state encryption key
 *   VERCEL_TOKEN           — Vercel API token
 *   RESTATE_INGRESS_URL    — Restate ingress endpoint
 *   FLAMECAST_RUNTIME_HOST_URL — RuntimeHost server endpoint
 */

import alchemy from "alchemy";
import { Project } from "alchemy/vercel";

const app = await alchemy("flamecast-vercel", {
  password: process.env.ALCHEMY_PASSWORD,
});

await Project("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  environmentVariables: [
    {
      key: "RESTATE_INGRESS_URL",
      value: process.env.RESTATE_INGRESS_URL ?? "",
      target: ["production", "preview"],
      type: "sensitive",
    },
    {
      key: "FLAMECAST_RUNTIME_HOST",
      value: "remote",
      target: ["production", "preview"],
      type: "plain",
    },
    {
      key: "FLAMECAST_RUNTIME_HOST_URL",
      value: process.env.FLAMECAST_RUNTIME_HOST_URL ?? "",
      target: ["production", "preview"],
      type: "sensitive",
    },
  ],
});

await app.finalize();
