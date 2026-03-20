import { spawn } from "node:child_process";
import path from "node:path";
import { getAgentTransport } from "../transport.js";
import type { SandboxProvisioner } from "../sandbox.js";

function runDocker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `docker exited with ${code ?? signal}`));
    });
  });
}

function dockerImageTag(connectionId: string): string {
  const safe = connectionId.replace(/[^a-zA-Z0-9_.-]/g, "-").toLowerCase() || "0";
  return `flamecast/agent:conn-${safe}`;
}

export const dockerProvisioner: SandboxProvisioner = {
  async start(opts) {
    const docker = opts.docker;
    if (!docker) {
      throw new Error("Docker runtime requires dockerfile and build context (docker options)");
    }
    const connectionId = opts.connectionId ?? "0";
    const imageTag = dockerImageTag(connectionId);
    const dockerfilePath = path.isAbsolute(docker.dockerfile)
      ? docker.dockerfile
      : path.join(docker.contextDir, docker.dockerfile);

    await runDocker(["build", "-f", dockerfilePath, "-t", imageTag, docker.contextDir]);

    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      imageTag,
      opts.spawn.command,
      ...(opts.spawn.args ?? []),
    ];
    const dockerProcess = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const { input, output } = getAgentTransport(dockerProcess);

    return {
      streams: { input, output },
      dispose: () => {
        dockerProcess.kill();
        void runDocker(["rmi", "-f", imageTag]).catch(() => {
          /* best-effort cleanup */
        });
      },
    };
  },
};
