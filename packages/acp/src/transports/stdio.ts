/**
 * Stdio transport — spawns agent as a child process, pipes stdin/stdout
 * through ndJsonStream to produce a Stream.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Transport, TransportConnection } from "../transport.js";

export interface StdioConnectOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Label for stderr logging (e.g. "claude-acp:run-123"). */
  label?: string;
}

export class StdioTransport implements Transport<StdioConnectOptions> {
  async connect(
    opts: StdioConnectOptions,
  ): Promise<TransportConnection & { proc: ChildProcess }> {
    const ac = new AbortController();

    const proc = spawn(opts.cmd, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
    });

    proc.on("exit", () => ac.abort());
    proc.on("error", () => ac.abort());

    if (opts.label) {
      proc.stderr!.on("data", (chunk: Buffer) => {
        console.error(`[${opts.label}] ${chunk.toString().trimEnd()}`);
      });
    }

    const stdinWeb = Writable.toWeb(proc.stdin!);
    const stdoutWeb = Readable.toWeb(
      proc.stdout! as import("node:stream").Readable,
    ) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);

    return {
      stream,
      proc,
      signal: ac.signal,
      async close() {
        proc.kill();
      },
    };
  }
}
