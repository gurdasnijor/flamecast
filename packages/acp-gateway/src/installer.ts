import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { SpawnConfig } from "./registry.js";
import { getPlatformKey } from "./registry.js";

const CACHE_DIR = join(homedir(), ".cache", "acp-gateway");

function agentCacheDir(id: string, version: string): string {
  return join(CACHE_DIR, id, version);
}

export async function ensureInstalled(config: SpawnConfig): Promise<string> {
  if (config.distribution.type !== "binary") {
    return "cmd" in config.distribution ? config.distribution.cmd : config.distribution.type;
  }

  const cacheDir = agentCacheDir(config.id, config.manifest.version);
  const cmdPath = join(cacheDir, config.distribution.cmd);

  if (existsSync(cmdPath)) {
    return cmdPath;
  }

  // Need to download — get archive URL from CDN
  const cdnRes = await fetch(
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
  );
  const cdn = (await cdnRes.json()) as {
    agents: Array<{
      id: string;
      distribution: {
        binary?: Record<string, { archive: string; cmd: string }>;
      };
    }>;
  };
  const cdnAgent = cdn.agents.find((a) => a.id === config.id);
  const platformKey = getPlatformKey();
  const platDist = cdnAgent?.distribution.binary?.[platformKey];

  if (!platDist) {
    throw new Error(
      `No binary archive for ${config.id} on ${platformKey}`,
    );
  }

  console.log(`Installing ${config.id}@${config.manifest.version}...`);
  mkdirSync(cacheDir, { recursive: true });

  const archiveUrl = platDist.archive;
  const archivePath = join(cacheDir, "archive.tar.gz");

  // Download
  const archiveRes = await fetch(archiveUrl);
  if (!archiveRes.ok) {
    throw new Error(`Failed to download ${archiveUrl}: ${archiveRes.status}`);
  }
  const buffer = Buffer.from(await archiveRes.arrayBuffer());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(archivePath, buffer);

  // Extract
  execSync(`tar -xzf archive.tar.gz`, { cwd: cacheDir });

  // Make executable
  if (existsSync(cmdPath)) {
    chmodSync(cmdPath, 0o755);
  }

  console.log(`Installed ${config.id} → ${cmdPath}`);
  return cmdPath;
}
