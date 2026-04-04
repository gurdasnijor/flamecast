/**
 * Agent registry — fetches spawn configs from the ACP CDN at boot.
 */

const CDN_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export interface SpawnConfig {
  id: string;
  env?: Record<string, string>;
  distribution:
    | { type: "npx"; cmd: string; args: string[]; env?: Record<string, string> }
    | { type: "url"; url: string };
}

export async function fetchAgentConfigs(agentIds: string[]): Promise<Map<string, SpawnConfig>> {
  const res = await fetch(CDN_URL);
  if (!res.ok) throw new Error(`CDN registry fetch failed: ${res.status}`);
  type CdnAgent = { id: string; distribution: { npx?: { package: string; args?: string[]; env?: Record<string, string> } } };
  const { agents } = (await res.json()) as { agents: CdnAgent[] };
  const cdnMap = new Map(agents.map((a) => [a.id, a]));

  const configs = new Map<string, SpawnConfig>();
  for (const id of agentIds) {
    const a = cdnMap.get(id);
    if (!a?.distribution.npx) { console.warn(`Agent "${id}" not in registry, skipping`); continue; }
    configs.set(id, {
      id,
      distribution: { type: "npx", cmd: "npx", args: [a.distribution.npx.package, ...(a.distribution.npx.args ?? [])], env: a.distribution.npx.env },
    });
  }
  return configs;
}
