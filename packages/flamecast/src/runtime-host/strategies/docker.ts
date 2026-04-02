/**
 * DockerStrategy — spawn agent processes inside Docker containers.
 *
 * Uses dockerode (Docker Engine API over socket) — no Docker CLI needed.
 * The container runs the agent with stdio pipes, same ACP protocol as local.
 *
 * Reference: docs/re-arch-unification.md Change 3, Step 9
 */

import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import type { AgentSpec, ProcessHandle } from "../types.js";

const docker = new Docker(); // connects to /var/run/docker.sock

export interface DockerProcessHandle extends ProcessHandle {
  containerId: string;
}

export async function dockerSpawn(
  sessionId: string,
  spec: AgentSpec,
): Promise<{ stdin: Writable; stdout: Readable; handle: DockerProcessHandle }> {
  if (!spec.containerImage) {
    throw new Error("AgentSpec.containerImage required for docker strategy");
  }

  // Pull image if not present
  try {
    await docker.getImage(spec.containerImage).inspect();
  } catch {
    console.log(`[docker] Pulling ${spec.containerImage}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(spec.containerImage!, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  const env = spec.env
    ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`)
    : [];

  // Pass through host env for API keys
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GITHUB_TOKEN"]) {
    if (process.env[key]) env.push(`${key}=${process.env[key]}`);
  }

  const container = await docker.createContainer({
    Image: spec.containerImage,
    name: `flamecast-${sessionId}`,
    Env: env,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    ...(spec.cwd ? { WorkingDir: spec.cwd } : {}),
    HostConfig: {
      AutoRemove: true,
    },
  });

  // Attach to get multiplexed stdin/stdout/stderr stream
  const attachStream = await container.attach({
    stream: true,
    stdin: true,
    stdout: true,
    stderr: true,
    hijack: true,
  });

  await container.start();

  // Demux stdout/stderr from the multiplexed stream
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(attachStream, stdout, stderr);

  stderr.on("data", (chunk: Buffer) => {
    console.error(`[docker-agent-stderr] ${chunk.toString().trimEnd()}`);
  });

  const handle: DockerProcessHandle = {
    sessionId,
    strategy: "docker",
    containerId: container.id,
    agentName: spec.containerImage,
  };

  // attachStream is writable (stdin) and demuxed into stdout/stderr
  return { stdin: attachStream as unknown as Writable, stdout: stdout as Readable, handle };
}

export async function dockerStop(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    await container.stop();
  } catch {
    // Container may already be stopped/removed
  }
}
