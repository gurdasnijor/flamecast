/**
 * Entry point for the RuntimeHost HTTP server.
 *
 * Run this on a separate machine/container from the API server + Restate.
 * It wraps InProcessRuntimeHost over HTTP so RemoteRuntimeHost can delegate.
 *
 * Required env:
 *   RESTATE_INGRESS_URL — Restate ingress for awakeable resolution + pubsub
 *
 * Optional env:
 *   RUNTIME_HOST_PORT — listen port (default: 9100)
 */

import { serve } from "@hono/node-server";
import { createRuntimeHostServer } from "./server.js";

const port = parseInt(process.env.RUNTIME_HOST_PORT ?? "9100", 10);
const restateIngressUrl =
  process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";

const { app } = createRuntimeHostServer({ restateIngressUrl });

serve({ fetch: app.fetch, port }, () => {
  console.log(`RuntimeHost server listening on :${port}`);
  console.log(`  Restate ingress: ${restateIngressUrl}`);
});
