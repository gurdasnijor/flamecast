/**
 * Dev worker entry — uses URL-based Restate (plain Docker containers).
 * No CF Container bindings needed.
 */
import { Flamecast } from "@flamecast/sdk";

const flamecast = new Flamecast({
  restateUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

export default flamecast.app;
