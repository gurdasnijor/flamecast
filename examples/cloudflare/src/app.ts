import { Container } from "@cloudflare/containers";
import { Flamecast } from "@flamecast/sdk";

// ─── Container DO classes ───────────────────────────────────────────────

export class RestateServer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}

export class RuntimeHostServer extends Container {
  defaultPort = 9100;
  sleepAfter = "5m";
}

// ─── Hono app ───────────────────────────────────────────────────────────

const flamecast = new Flamecast({
  restateUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

export default flamecast.app;
