import * as restate from "@restatedev/restate-sdk";
import { pubsubObject } from "./pubsub.js";
import { AcpSession } from "./session.js";
import { AcpAgents } from "./agents.js";

export const services = [pubsubObject, AcpSession, AcpAgents];

export function serve(port = 9080) {
  return restate.serve({ services, port });
}
