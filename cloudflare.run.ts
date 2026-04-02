import path from "node:path";
import alchemy from "alchemy";
import { Container, Worker, Vite } from "alchemy/cloudflare";
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

export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./examples/cloudflare/src/app.ts",
  format: "esm",
  compatibility: "node",
  bindings: {
    RESTATE: restateContainer,
    RUNTIME_HOST: runtimeHostContainer,
  },
  url: true,
  dev: {
    port: 3001,
  },
});

export const client = await Vite("flamecast-client", {
  name: `flamecast-client-${app.stage}`,
  cwd: "./apps/client",
  bindings: {
    VITE_API_URL: `${server.url?.replace(/\/$/, "")}/api`,
  },
  dev: {
    command: `PATH=${path.dirname(process.execPath)}:$PATH npx vite dev --port 3000`,
  },
});

console.log(`API:    ${server.url}`);
console.log(`Client: ${client.url}`);

await app.finalize();
