/**
 * AcpAgents — stateless Restate service for agent discovery.
 *
 * Adopts the BeeAI ACP discovery spec (GET /agents, GET /agents/{name})
 * as Restate service handlers.
 */

import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { loadRegistryFromIds, type SpawnConfig } from "@flamecast/acp/registry";

export const AgentManifest = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  icon: z.string().optional(),
});

export type AgentInfo = z.infer<typeof AgentManifest>;

const GetAgentInput = z.object({
  name: z.string(),
});

const agentIds = (process.env.ACP_AGENTS ?? "claude-acp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let cachedConfigs: SpawnConfig[] | null = null;

async function getConfigs(): Promise<SpawnConfig[]> {
  if (!cachedConfigs) {
    cachedConfigs = await loadRegistryFromIds(agentIds);
  }
  return cachedConfigs;
}

function configToManifest(c: SpawnConfig): z.infer<typeof AgentManifest> {
  return {
    name: c.id,
    description: c.manifest.description,
    version: c.manifest.version,
    icon: c.manifest.icon,
  };
}

async function listAgents(_ctx: restate.Context): Promise<z.infer<typeof AgentManifest>[]> {
  const configs = await getConfigs();
  return configs.map(configToManifest);
}

async function getAgent(
  _ctx: restate.Context,
  input: z.infer<typeof GetAgentInput>,
): Promise<z.infer<typeof AgentManifest>> {
  const configs = await getConfigs();
  const config = configs.find((c) => c.id === input.name || c.manifest.name === input.name);
  if (!config) {
    throw new restate.TerminalError(`Agent not found: ${input.name}`);
  }
  return configToManifest(config);
}

export const AcpAgents = restate.service({
  name: "AcpAgents",
  handlers: {
    listAgents: restate.handlers.handler(
      { output: restate.serde.schema(z.array(AgentManifest)) },
      listAgents,
    ),
    getAgent: restate.handlers.handler(
      {
        input: restate.serde.schema(GetAgentInput),
        output: restate.serde.schema(AgentManifest),
      },
      getAgent,
    ),
  },
});
