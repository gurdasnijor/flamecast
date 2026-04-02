import { pubsubObject } from "./pubsub.js";
import { AcpSession } from "../acp/session.js";
import * as restate from "@restatedev/restate-sdk";

export const services = [
  pubsubObject,
  AcpSession,
];

export function serve(port = 9080) {
  return restate.serve({ services, port });
}
