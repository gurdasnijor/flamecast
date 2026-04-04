import * as restate from "@restatedev/restate-sdk";
import { pubsubObject } from "./pubsub.js";
import { AcpAgent } from "./agent.js";

export function serve(port = 9080) {
  return restate.serve({ services: [pubsubObject, AcpAgent], port });
}
