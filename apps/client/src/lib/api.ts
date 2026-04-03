import { createFlamecastClient } from "@flamecast/client";

// In dev, Vite proxies /restate/* → Restate ingress (avoids CORS).
// In prod, set VITE_RESTATE_INGRESS_URL to the ingress proxy.
const ingressUrl =
  import.meta.env.VITE_RESTATE_INGRESS_URL ?? "/restate";

export const client = createFlamecastClient({ ingressUrl });
