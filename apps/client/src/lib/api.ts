import * as acp from "@agentclientprotocol/sdk";
import { FlamecastClient } from "@flamecast/sdk/client";

export const ingressUrl =
  import.meta.env.VITE_RESTATE_INGRESS_URL ?? "/restate";

/**
 * Browser-side acp.Client — handles agent callbacks in the UI.
 */
export class BrowserClient implements acp.Client {
  onSessionUpdate?: (params: acp.SessionNotification) => void;
  onPermissionRequest?: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;

  async sessionUpdate(params: acp.SessionNotification) {
    this.onSessionUpdate?.(params);
  }

  async requestPermission(params: acp.RequestPermissionRequest) {
    if (this.onPermissionRequest) return this.onPermissionRequest(params);
    return {
      outcome: {
        outcome: "selected" as const,
        optionId: params.options[0]?.optionId ?? "",
      },
    };
  }
}

/** Shared FlamecastClient instance */
export const flamecast = new FlamecastClient({ ingressUrl });

/**
 * Agent discovery — fetches from the ACP CDN registry.
 */
const CDN_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export async function listAgents(agentIds: string[]): Promise<Array<{ id: string; name: string; description?: string }>> {
  const res = await fetch(CDN_REGISTRY_URL);
  if (!res.ok) return [];
  const { agents } = await res.json() as { agents: Array<{ id: string; name: string; description?: string }> };
  const idSet = new Set(agentIds);
  return agents.filter((a) => idSet.has(a.id)).map(({ id, name, description }) => ({ id, name, description }));
}
