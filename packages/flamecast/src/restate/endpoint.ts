import { pubsubObject } from "./pubsub.js";
import { AcpRun } from "../acp/run-vo.js";
import { acpAgents } from "../acp/agent-service.js";
import * as restate from "@restatedev/restate-sdk";

export const services = [
  pubsubObject,
  AcpRun,
  acpAgents,
];

export function serve(port = 9080) {
  return restate.serve({ services, port });
}
