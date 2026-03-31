import { createRestateEndpoint } from "./endpoint.js";

const port = parseInt(process.env.RESTATE_ENDPOINT_PORT ?? "9080", 10);
createRestateEndpoint().listen(port).then(() => {
  console.log(`[restate] Flamecast services listening on port ${port}`);
});
