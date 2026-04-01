import type { AgentTemplate } from "@flamecast/sdk";

/**
 * Default agent templates seeded from the ACP registry.
 * https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 *
 * Uses npx to run agents — they're downloaded on first use.
 * In-memory config, no database needed.
 */
export function createAgentTemplates(): AgentTemplate[] {
  return [
    {
      id: "claude",
      name: "Claude",
      spawn: { command: "npx", args: ["@agentclientprotocol/claude-agent-acp@0.24.2"] },
      runtime: { provider: "default" },
    },
    {
      id: "gemini",
      name: "Gemini",
      spawn: { command: "npx", args: ["@google/gemini-cli@0.35.3", "--acp"] },
      runtime: { provider: "default" },
    },
    {
      id: "codex",
      name: "Codex",
      spawn: { command: "npx", args: ["@zed-industries/codex-acp@0.10.0"] },
      runtime: { provider: "default" },
    },
    {
      id: "copilot",
      name: "GitHub Copilot",
      spawn: { command: "npx", args: ["@github/copilot@1.0.14", "--acp"] },
      runtime: { provider: "default" },
    },
    {
      id: "kilo",
      name: "Kilo Code",
      spawn: { command: "npx", args: ["@kilocode/cli@7.1.11", "acp"] },
      runtime: { provider: "default" },
    },
    {
      id: "cline",
      name: "Cline",
      spawn: { command: "npx", args: ["cline@2.11.0", "--acp"] },
      runtime: { provider: "default" },
    },
  ];
}
