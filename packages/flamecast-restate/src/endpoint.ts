import * as restate from "@restatedev/restate-sdk";
import { FlamecastSession, pubsubObject } from "./session-object.js";
import { WebhookDeliveryService } from "./webhook-service.js";

export const services = [FlamecastSession, WebhookDeliveryService, pubsubObject];

/** Start the Flamecast Restate endpoint on the given port. */
export function serve(port = 9080) {
  return restate.serve({ services, port });
}
