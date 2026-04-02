import { Container, getContainer } from "@cloudflare/containers";
import { Flamecast } from "@flamecast/sdk";
import type { server } from "../../../cloudflare.run.ts";

// ─── Container DO classes ───────────────────────────────────────────────

export class RestateServer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}

export class RuntimeHostServer extends Container {
  defaultPort = 9100;
  sleepAfter = "5m";
}

// ─── Worker ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: typeof server.Env): Promise<Response> {
    const restate = getContainer(env.RESTATE, "restate");

    const flamecast = new Flamecast({
      restateUrl: "http://restate",
      fetch: (input, init) => restate.fetch(new Request(input, init)),
    });

    return flamecast.app.fetch(request);
  },
};
