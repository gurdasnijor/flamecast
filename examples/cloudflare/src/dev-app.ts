/**
 * Dev worker entry — uses URL-based Restate (plain Docker containers).
 * Seeds agent templates from the ACP registry.
 */
import { Flamecast } from "@flamecast/sdk";
import { createAgentTemplates } from "../../../apps/server/src/agent-templates.js";

const flamecast = new Flamecast({
  agentTemplates: await createAgentTemplates(),
  restateUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

export default flamecast.app;
