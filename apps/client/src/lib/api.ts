import * as acp from "@agentclientprotocol/sdk";
import { createRestateStream } from "@flamecast/sdk/client";
import { createPubsubClient } from "@restatedev/pubsub-client";

export const ingressUrl =
  import.meta.env.VITE_RESTATE_INGRESS_URL ?? "/restate";

export const pubsub = createPubsubClient({
  name: "pubsub",
  ingressUrl,
  pullInterval: { milliseconds: 300 },
});

/**
 * Browser-side acp.Client — handles agent callbacks in the UI.
 * Extend this per page/component to render sessionUpdates and permission dialogs.
 */
export class BrowserClient implements acp.Client {
  onSessionUpdate?: (params: acp.SessionNotification) => void;
  onPermissionRequest?: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;

  async sessionUpdate(params: acp.SessionNotification) {
    this.onSessionUpdate?.(params);
  }

  async requestPermission(params: acp.RequestPermissionRequest) {
    if (this.onPermissionRequest) return this.onPermissionRequest(params);
    // Auto-approve first option
    return {
      outcome: {
        outcome: "selected" as const,
        optionId: params.options[0]?.optionId ?? "",
      },
    };
  }
}

/**
 * Connect to an AcpAgent session. Returns a standard ClientSideConnection.
 * Same as connecting to a local agent via stdio — just different transport.
 */
export function connectSession(sessionKey: string, client: acp.Client): acp.ClientSideConnection {
  const stream = createRestateStream({ ingressUrl, sessionKey, pubsub });
  return new acp.ClientSideConnection(() => client, stream);
}

/**
 * Agent discovery — fetches from the ACP CDN registry.
 * Not an ACP session concern, doesn't go through the VO.
 */
const CDN_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export async function listAgents(agentIds: string[]): Promise<Array<{ id: string; name: string; description?: string }>> {
  const res = await fetch(CDN_REGISTRY_URL);
  if (!res.ok) return [];
  const { agents } = await res.json() as { agents: Array<{ id: string; name: string; description?: string }> };
  const idSet = new Set(agentIds);
  return agents.filter((a) => idSet.has(a.id)).map(({ id, name, description }) => ({ id, name, description }));
}
