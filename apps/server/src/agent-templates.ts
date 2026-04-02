import type { AgentTemplate } from "@flamecast/sdk";

const REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  website?: string;
  authors?: string[];
  license?: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<string, { archive: string; cmd: string }>;
    uvx?: { package: string; args?: string[] };
    docker?: { image: string };
  };
}

function registryToTemplate(agent: RegistryAgent): AgentTemplate | null {
  const dist = agent.distribution;

  if (dist.npx) {
    return {
      id: agent.id,
      name: agent.name,
      spawn: {
        command: "npx",
        args: [dist.npx.package, ...(dist.npx.args ?? [])],
      },
      runtime: { provider: "default" },
      env: dist.npx.env,
      description: agent.description,
      icon: agent.icon,
    };
  }

  // Skip binary/uvx for now — need platform detection
  return null;
}

/**
 * Fetch agent templates from the ACP registry.
 * Falls back to empty list on network error.
 */
export async function createAgentTemplates(): Promise<AgentTemplate[]> {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) return [];
    const data = (await res.json()) as { agents: RegistryAgent[] };
    return data.agents
      .map(registryToTemplate)
      .filter((t): t is AgentTemplate => t !== null);
  } catch {
    console.warn("Failed to fetch ACP registry, using empty template list");
    return [];
  }
}
