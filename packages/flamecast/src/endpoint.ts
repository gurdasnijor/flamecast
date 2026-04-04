import * as restate from "@restatedev/restate-sdk";
import { AgentConnection } from "./agent-connection.js";
import { AgentSession } from "./agent-session.js";

export function serve(port = 9080) {
  return restate.serve({ services: [AgentConnection, AgentSession], port });
}
