import { readFileSync } from "node:fs";

const CDN_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export interface AgentManifest {
  name: string;
  description?: string;
  version: string;
  icon?: string;
}

export type TransportType = "stdio" | "http-sse" | "websocket";

export interface SpawnConfig {
  id: string;
  manifest: AgentManifest;
  env?: Record<string, string>;
  transport?: TransportType;
  distribution:
    | { type: "npx"; cmd: string; args: string[]; env?: Record<string, string> }
    | { type: "binary"; cmd: string; args: string[] }
    | { type: "uvx"; cmd: string; args: string[] }
    | { type: "url"; url: string };
}

// Registry entry: either a bare string ID or an object with overrides
type RegistryEntry =
  | string
  | { id: string; env?: Record<string, string>; transport?: TransportType; url?: string };

interface CdnRegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<string, { archive: string; cmd: string; args?: string[] }>;
    uvx?: { package: string; args?: string[] };
  };
}

function getPlatformKey(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "darwin" : "linux";
  return `${os}-${arch}`;
}

function resolveAgent(
  id: string,
  cdnAgent: CdnRegistryAgent,
  installedBinaryPath?: string,
): SpawnConfig {
  const manifest: AgentManifest = {
    name: cdnAgent.name,
    description: cdnAgent.description,
    version: cdnAgent.version,
    icon: cdnAgent.icon,
  };

  const dist = cdnAgent.distribution;

  // Prefer binary if installed
  if (installedBinaryPath && dist.binary) {
    const platformKey = getPlatformKey();
    const platDist = dist.binary[platformKey];
    return {
      id,
      manifest,
      distribution: {
        type: "binary",
        cmd: installedBinaryPath,
        args: platDist?.args ?? [],
      },
    };
  }

  // npx
  if (dist.npx) {
    return {
      id,
      manifest,
      distribution: {
        type: "npx",
        cmd: "npx",
        args: [dist.npx.package, ...(dist.npx.args ?? [])],
        env: dist.npx.env,
      },
    };
  }

  // binary (needs install)
  if (dist.binary) {
    const platformKey = getPlatformKey();
    const platDist = dist.binary[platformKey];
    if (!platDist) {
      throw new Error(
        `No binary for platform ${platformKey} for agent ${id}`,
      );
    }
    return {
      id,
      manifest,
      distribution: {
        type: "binary",
        cmd: platDist.cmd,
        args: platDist.args ?? [],
      },
    };
  }

  // uvx
  if (dist.uvx) {
    return {
      id,
      manifest,
      distribution: {
        type: "uvx",
        cmd: "uvx",
        args: [dist.uvx.package, ...(dist.uvx.args ?? [])],
      },
    };
  }

  throw new Error(`No distribution found for agent ${id}`);
}

export async function loadRegistry(
  registryPath: string,
): Promise<SpawnConfig[]> {
  const raw = readFileSync(registryPath, "utf8");
  const { agents: entries } = JSON.parse(raw) as { agents: RegistryEntry[] };

  const res = await fetch(CDN_REGISTRY_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch CDN registry: ${res.status}`);
  }
  const cdn = (await res.json()) as { agents: CdnRegistryAgent[] };
  const cdnMap = new Map(cdn.agents.map((a) => [a.id, a]));

  const configs: SpawnConfig[] = [];
  for (const entry of entries) {
    const id = typeof entry === "string" ? entry : entry.id;
    const userEnv = typeof entry === "object" ? entry.env : undefined;

    const cdnAgent = cdnMap.get(id);
    if (!cdnAgent) {
      console.warn(`Agent "${id}" not found in CDN registry, skipping`);
      continue;
    }
    const config = resolveAgent(id, cdnAgent);
    if (userEnv) config.env = userEnv;
    if (typeof entry === "object") {
      if (entry.transport) config.transport = entry.transport;
      if (entry.url) config.distribution = { type: "url", url: entry.url };
    }
    configs.push(config);
  }

  return configs;
}

export { getPlatformKey };
