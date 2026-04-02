import { Flamecast } from "@flamecast/sdk";
import dotenv from "dotenv";

dotenv.config();

const restateIngressUrl = process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";

const flamecast = new Flamecast({
  restateUrl: restateIngressUrl,
});

const server = flamecast.listen(3001, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
  console.log(`  Restate ingress: ${restateIngressUrl}`);
});

process.on("SIGINT", () => server.close().then(() => process.exit(0)));
process.on("SIGTERM", () => server.close().then(() => process.exit(0)));
