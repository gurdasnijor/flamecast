import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";

function toUint8ReadableStream(
  stream: ReturnType<typeof Readable.toWeb>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const reader = stream.getReader();
      async function pump(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
          return pump();
        });
      }
      pump();
    },
  });
}

export function getAgentTransport() {
  // Get the current file's directory to find agent.ts
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const agentPath = join(__dirname, "agent.ts");

  // Spawn the agent as a subprocess via npx (npx.cmd on Windows) using tsx
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const agentProcess = spawn(npxCmd, ["tsx", agentPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  // Create streams to communicate with the agent
  const stdin = agentProcess.stdin;
  const stdout = agentProcess.stdout;
  if (!stdin || !stdout) {
    throw new Error("Failed to get stdin/stdout from agent process");
  }
  const input = Writable.toWeb(stdin);
  const output = toUint8ReadableStream(Readable.toWeb(stdout));

  return {
    input,
    output,
    agentProcess,
  };
}
