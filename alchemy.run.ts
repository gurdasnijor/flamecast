import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";
import { Database, Branch, Password } from "alchemy/planetscale";
import { Exec } from "alchemy/os";

const app = await alchemy("flamecast-infra");

// ---------------------------------------------------------------------------
// Database — PlanetScale with Drizzle migrations
// ---------------------------------------------------------------------------

const database = await Database("flamecast-db", {
  adopt: true,
  name: `flamecast-${app.stage}`,
  region: { slug: "us-east" },
  migrationFramework: "other",
  migrationTableName: "__drizzle_migrations",
});

const branch = await Branch("flamecast-branch", {
  adopt: true,
  name: `flamecast-${app.stage}-branch`,
  database,
  parentBranch: database.defaultBranch,
});

const password = await Password("flamecast-password", {
  name: `flamecast-${app.stage}-password`,
  database,
  branch,
  role: "admin",
});

// Run Drizzle migrations at deploy time
await Exec("drizzle-migrate", {
  command: "npx drizzle-kit migrate",
  env: {
    DATABASE_NAME: database.name,
    DATABASE_HOST: password.host,
    DATABASE_USERNAME: password.username,
    DATABASE_PASSWORD: password.password,
  },
});

// ---------------------------------------------------------------------------
// Server — Flamecast API as a Cloudflare Worker
// ---------------------------------------------------------------------------

export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./src/worker.ts",
  bindings: {
    DATABASE_URL: `mysql://${password.username}:${password.password}@${password.host}/${database.name}?ssl={"rejectUnauthorized":true}`,
  },
  url: true,
});

console.log(`Flamecast API: ${server.url}`);

await app.finalize();
