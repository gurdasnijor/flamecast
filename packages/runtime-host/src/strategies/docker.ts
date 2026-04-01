/**
 * DockerStrategy — spawn agent processes inside Docker containers.
 *
 * Uses `docker run` with stdio pipes, same ACP protocol as local.
 * The container image must have the agent binary installed.
 *
 * Reference: docs/re-arch-unification.md Change 3, Step 9
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentSpec, ProcessHandle } from "../types.js";

export interface DockerProcessHandle extends ProcessHandle {
  containerId: string;
}

export async function dockerSpawn(
  sessionId: string,
  spec: AgentSpec,
): Promise<{ proc: ChildProcess; handle: DockerProcessHandle }> {
  if (!spec.containerImage) {
    throw new Error("AgentSpec.containerImage required for docker strategy");
  }

  const args = [
    "run",
    "--rm",
    "-i", // interactive (stdin open)
    "--name", `flamecast-${sessionId}`,
  ];

  // Mount cwd as workspace
  if (spec.cwd) {
    args.push("-v", `${spec.cwd}:/workspace`, "-w", "/workspace");
  }

  // Pass env vars
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) {
      args.push("-e", `${k}=${v}`);
    }
  }

  args.push(spec.containerImage);

  // Append agent binary + args
  if (spec.binary) args.push(spec.binary);
  if (spec.args) args.push(...spec.args);

  const proc = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    console.error(`[docker-agent-stderr] ${chunk.toString().trimEnd()}`);
  });

  // Get container ID
  const containerId = `flamecast-${sessionId}`;

  const handle: DockerProcessHandle = {
    sessionId,
    strategy: "docker",
    pid: proc.pid,
    containerId,
    agentName: spec.binary ?? spec.containerImage,
  };

  return { proc, handle };
}

export async function dockerStop(containerId: string): Promise<void> {
  const proc = spawn("docker", ["stop", containerId], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve());
  });
}
