/**
 * Dev worker entry — uses URL-based Restate (plain Docker containers).
 * Fetches agent templates from ACP registry on first request.
 */
import { Flamecast } from "@flamecast/sdk";
import { createAgentTemplates } from "../../../apps/server/src/agent-templates.js";

let flamecast: Flamecast | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    if (!flamecast) {
      flamecast = new Flamecast({
        agentTemplates: await createAgentTemplates(),
        restateUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
      });
    }
    return flamecast.app.fetch(request);
  },
};
