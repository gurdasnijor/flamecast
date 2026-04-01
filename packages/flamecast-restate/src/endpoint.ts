import * as restate from "@restatedev/restate-sdk";
import { pubsubObject } from "./pubsub.js";
import { IbmAgentSession } from "./ibm-agent-session.js";
import { ZedAgentSession } from "./zed-agent-session.js";

export const services = [
  pubsubObject,
  IbmAgentSession,
  ZedAgentSession,
];

/** Start the Flamecast Restate endpoint on the given port. */
export function serve(port = 9080) {
  return restate.serve({ services, port });
}
