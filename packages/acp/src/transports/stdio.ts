/**
 * Stdio — spawns an agent as a child process, returns byte streams
 * over stdin/stdout.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { ByteConnection } from "../transport.js";

export interface StdioConnectOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  label?: string;
}

export async function connectStdio(
  opts: StdioConnectOptions,
): Promise<ByteConnection & { proc: ChildProcess }> {
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

  const writable = Writable.toWeb(proc.stdin!);
  const readable = Readable.toWeb(
    proc.stdout! as import("node:stream").Readable,
  ) as unknown as ReadableStream<Uint8Array>;

  return {
    readable,
    writable,
    proc,
    signal: ac.signal,
    async close() {
      proc.kill();
    },
  };
}
