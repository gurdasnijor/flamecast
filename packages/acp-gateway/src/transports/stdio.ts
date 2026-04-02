/**
 * Stdio transport — spawns agent as a child process, pipes stdin/stdout
 * through ndJsonStream to produce a Stream for ClientSideConnection.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentTransport, TransportConnection } from "../transport.js";
import type { SpawnConfig } from "../registry.js";

export class StdioTransport implements AgentTransport {
  async connect(
    config: SpawnConfig,
    runId: string,
    cwd: string,
  ): Promise<TransportConnection & { proc: ChildProcess }> {
    const resolvedCwd = cwd && existsSync(cwd) ? cwd : process.cwd();
    const dist = config.distribution;
    if (dist.type === "url") {
      throw new Error("StdioTransport does not support url distribution");
    }

    const proc = spawn(dist.cmd, dist.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: resolvedCwd,
      env: {
        ...process.env,
        ...(dist.type === "npx" ? dist.env : undefined),
        ...config.env,
      },
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[${config.id}:${runId}] ${chunk.toString().trimEnd()}`);
    });

    const stdinWeb = Writable.toWeb(proc.stdin!);
    const stdoutWeb = Readable.toWeb(
      proc.stdout! as import("node:stream").Readable,
    ) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);

    return {
      stream,
      proc,
      async close() {
        proc.kill();
      },
      async cancel() {
        // cancel is handled at the ACP protocol level (conn.cancel),
        // not at the transport level for stdio
      },
    };
  }
}
