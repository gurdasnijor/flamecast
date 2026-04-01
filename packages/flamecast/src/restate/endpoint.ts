import * as restate from "@restatedev/restate-sdk";
import { pubsubObject } from "./pubsub.js";
import { AgentSession } from "./agent-session.js";

export const services = [
  pubsubObject,
  AgentSession,
];

export function serve(port = 9080) {
  return restate.serve({ services, port });
}
