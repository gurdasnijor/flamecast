/**
 * Stdio transport — spawns an agent as a child process.
 *
 * connectStdio(opts, factory) → ClientSideConnection (you're the client)
 * serveStdio(factory)         → AgentSideConnection  (you're the agent)
 */

import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

export interface StdioConnectOptions {
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  label?: string;
}

/** Connect to a stdio agent subprocess → you get a ClientSideConnection (Agent). */
export function connectStdio(
  opts: StdioConnectOptions,
  clientFactory: (agent: acp.Agent) => acp.Client,
): acp.ClientSideConnection {
  const proc = spawn(opts.cmd, opts.args ?? [], {
    stdio: ["pipe", "pipe", opts.label ? "pipe" : "inherit"],
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd,
  });

  if (opts.label && proc.stderr) {
    proc.stderr.on("data", (chunk: Buffer) => {
      console.error(`[${opts.label}] ${chunk.toString().trimEnd()}`);
    });
  }

  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout! as import("node:stream").Readable) as ReadableStream<Uint8Array>,
  );

  return new acp.ClientSideConnection(clientFactory, stream);
}

/** Serve as a stdio agent (reads stdin, writes stdout). */
export function serveStdio(
  agentFactory: (conn: acp.AgentSideConnection) => acp.Agent,
): acp.AgentSideConnection {
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        process.stdin.on("end", () => controller.close());
      },
    }),
  );

  return new acp.AgentSideConnection(agentFactory, stream);
}
