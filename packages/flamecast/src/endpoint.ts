import * as restate from "@restatedev/restate-sdk";
import { AcpConnection } from "./connection.js";
import { pubsubObject } from "./pubsub.js";

export function serve(port = 9080) {
  return restate.serve({ services: [AcpConnection, pubsubObject], port });
}
