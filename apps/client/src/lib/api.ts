import { FlamecastClient } from "@flamecast/sdk/client";

const ingressUrl =
  import.meta.env.VITE_RESTATE_INGRESS_URL ?? "/restate";

export const client = new FlamecastClient({ ingressUrl });
