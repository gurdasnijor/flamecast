/**
 * E2BStrategy — spawn agent processes in E2B sandboxes.
 *
 * Uses E2B's sandbox API to create ephemeral compute environments.
 * The agent runs inside the sandbox with full filesystem + network.
 *
 * Requires E2B_API_KEY env var.
 *
 * Reference: docs/re-arch-unification.md Change 3, Step 9
 */

import type { AgentSpec, ProcessHandle } from "../types.js";

export interface E2BProcessHandle extends ProcessHandle {
  sandboxId: string;
  sandboxUrl: string;
}

/**
 * Spawn an agent in an E2B sandbox.
 *
 * Returns the sandbox URL for HTTP-based ACP communication.
 * The agent must be pre-installed in the sandbox template or
 * installable via the setup script.
 */
export async function e2bSpawn(
  sessionId: string,
  spec: AgentSpec,
): Promise<E2BProcessHandle> {
  if (!spec.sandboxTemplate) {
    throw new Error("AgentSpec.sandboxTemplate required for e2b strategy");
  }

  // Dynamic import — E2B SDK is optional
  const { Sandbox } = await import("e2b");

  const sandbox = await Sandbox.create(spec.sandboxTemplate, {
    metadata: { sessionId },
    envs: spec.env,
  });

  // Run setup if provided
  if (spec.binary && spec.args) {
    await sandbox.commands.run(
      [spec.binary, ...spec.args].join(" "),
      { cwd: spec.cwd ?? "/home/user" },
    );
  }

  return {
    sessionId,
    strategy: "e2b",
    sandboxId: sandbox.sandboxId,
    sandboxUrl: `https://${sandbox.getHost(3000)}`,
    agentName: spec.binary ?? spec.sandboxTemplate,
  };
}

export async function e2bStop(sandboxId: string): Promise<void> {
  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.connect(sandboxId);
  await sandbox.kill();
}
