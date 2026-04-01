/**
 * RuntimeHost factory — selects implementation by environment.
 *
 * FLAMECAST_RUNTIME_HOST=inprocess (default) → InProcessRuntimeHost
 * FLAMECAST_RUNTIME_HOST=remote → RemoteRuntimeHost (needs FLAMECAST_RUNTIME_HOST_URL)
 */

export type { RuntimeHost, AgentSpec, ProcessHandle, RuntimeHostCallbacks, StreamingEvent, PermissionRequest, PermissionDecision } from "./types.js";
export { InProcessRuntimeHost } from "./local.js";
export { RemoteRuntimeHost } from "./remote.js";
export { createRuntimeHostServer, type RuntimeHostServerOptions } from "./server.js";

import type { RuntimeHost } from "./types.js";
import { InProcessRuntimeHost } from "./local.js";
import { RemoteRuntimeHost } from "./remote.js";

export function createRuntimeHost(): RuntimeHost {
  const mode = process.env.FLAMECAST_RUNTIME_HOST ?? "inprocess";
  if (mode === "inprocess") return new InProcessRuntimeHost();
  const url = process.env.FLAMECAST_RUNTIME_HOST_URL;
  if (!url) {
    throw new Error(
      "FLAMECAST_RUNTIME_HOST_URL required when FLAMECAST_RUNTIME_HOST=remote",
    );
  }
  return new RemoteRuntimeHost(url);
}
