/**
 * InProcessRuntimeHost — local-first agent process manager.
 *
 * Spawns agent processes via child_process.spawn(), wires ACP SDK
 * (ClientSideConnection + ndJsonStream) over stdio, and holds live
 * connections in a process table keyed by sessionId.
 *
 * Reuses @agentclientprotocol/sdk — does NOT reimplement JSON-RPC.
 *
 * Reference: docs/re-arch-unification.md Change 3
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentSpec,
  ProcessHandle,
  RuntimeHost,
  RuntimeHostCallbacks,
  PermissionRequest,

  StreamingEvent,
} from "./types.js";
import type { PromptResultPayload } from "@flamecast/protocol/session";

// ─── Process table entry ──────────────────────────────────────────────────

interface ProcessEntry {
  proc: ChildProcess;
  conn: acp.ClientSideConnection;
  acpSessionId: string;
  client: AcpClient;
}

// ─── ACP Client (handles agent→client callbacks) ──────────────────────────

class AcpClient implements acp.Client {
  private callbacks: RuntimeHostCallbacks | null = null;
  private collectedText: string[] = [];
  private collecting = false;

  setCallbacks(cbs: RuntimeHostCallbacks | null): void {
    this.callbacks = cbs;
  }

  startCollecting(): void {
    this.collectedText = [];
    this.collecting = true;
  }

  stopCollecting(): string {
    this.collecting = false;
    const text = this.collectedText.join("");
    this.collectedText = [];
    return text;
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (!this.callbacks) {
      // No callbacks → auto-approve (fallback during start/init)
      return {
        outcome: {
          outcome: "selected",
          optionId: params.options[0].optionId,
        },
      };
    }

    const request: PermissionRequest = {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "Permission required",
      kind: params.toolCall.kind ?? undefined,
      options: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
    };

    const decision = await this.callbacks.onPermission(request);
    return {
      outcome: { outcome: "selected", optionId: decision.optionId },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    let event: StreamingEvent | null = null;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          if (this.collecting) {
            this.collectedText.push(update.content.text ?? "");
          }
          event = {
            type: "text",
            text: update.content.text ?? "",
            role: "assistant",
          };
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          event = {
            type: "text",
            text: update.content.text ?? "",
            role: "thinking",
          };
        }
        break;
      case "tool_call":
        event = {
          type: "tool",
          toolCallId: update.toolCallId,
          title: update.title,
          status: mapToolStatus(update.status),
          input: update.rawInput,
          output: update.rawOutput,
        };
        break;
      case "tool_call_update":
        event = {
          type: "tool",
          toolCallId: update.toolCallId,
          title: "",
          status: mapToolStatus(update.status),
          input: update.rawInput,
          output: update.rawOutput,
        };
        break;
    }

    if (event) {
      this.callbacks?.onEvent(event);
    }
  }
}

function mapToolStatus(
  s: acp.ToolCallStatus | undefined | null,
): "pending" | "running" | "completed" | "failed" {
  switch (s) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

function stopReasonToStatus(
  reason: acp.StopReason,
): PromptResultPayload["status"] {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "failed";
    default:
      return "completed";
  }
}

function toPromptInput(text: string): acp.ContentBlock[] {
  return [{ type: "text", text }];
}

// ─── InProcessRuntimeHost ─────────────────────────────────────────────────

export class InProcessRuntimeHost implements RuntimeHost {
  private processes = new Map<string, ProcessEntry>();

  async spawn(sessionId: string, spec: AgentSpec): Promise<ProcessHandle> {
    if (!spec.binary) {
      throw new Error("AgentSpec.binary is required for local strategy");
    }

    const proc = spawn(spec.binary, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[agent-stderr] ${chunk.toString().trimEnd()}`);
    });

    // Wire ACP SDK over stdio
    const stdinWeb = Writable.toWeb(proc.stdin!);
    const stdoutWeb = Readable.toWeb(
      proc.stdout! as import("node:stream").Readable,
    ) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);

    const client = new AcpClient();
    const conn = new acp.ClientSideConnection((_agent) => client, stream);

    // ACP initialize — kill process on failure to prevent leaks
    let initResult: Awaited<ReturnType<typeof conn.initialize>>;
    let sessionResult: Awaited<ReturnType<typeof conn.newSession>>;
    try {
      initResult = await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "flamecast", title: "Flamecast", version: "1.0.0" },
      });

      sessionResult = await conn.newSession({
        cwd: spec.cwd ?? process.cwd(),
        mcpServers: [],
      });
    } catch (err) {
      proc.kill();
      throw err;
    }

    const acpSessionId = sessionResult.sessionId;

    const entry: ProcessEntry = { proc, conn, acpSessionId, client };
    this.processes.set(sessionId, entry);

    // Clean up on process exit
    conn.signal.addEventListener("abort", () => {
      this.processes.delete(sessionId);
    });

    return {
      sessionId,
      strategy: spec.strategy,
      pid: proc.pid,
      agentName:
        initResult.agentInfo?.name ??
        spec.binary.split("/").pop() ??
        "agent",
      agentDescription: initResult.agentInfo?.title,
      agentCapabilities: initResult.agentCapabilities as
        | Record<string, unknown>
        | undefined,
    };
  }

  async prompt(
    handle: ProcessHandle,
    text: string,
    callbacks: RuntimeHostCallbacks,
    _awakeableId?: string,
  ): Promise<void> {
    const entry = this.processes.get(handle.sessionId);
    if (!entry) {
      callbacks.onError(
        new Error(`No process for session ${handle.sessionId}`),
      );
      return;
    }

    entry.client.setCallbacks(callbacks);
    entry.client.startCollecting();

    try {
      const result = await entry.conn.prompt({
        sessionId: entry.acpSessionId,
        prompt: toPromptInput(text),
      });
      const collectedText = entry.client.stopCollecting();

      const output = collectedText
        ? [
            {
              role: "assistant" as const,
              parts: [{ contentType: "text/plain", content: collectedText }],
            },
          ]
        : undefined;

      callbacks.onComplete({
        status: stopReasonToStatus(result.stopReason),
        output,
        runId: handle.sessionId,
      });
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : JSON.stringify(error);
      callbacks.onComplete({
        status: "failed",
        error: msg,
        runId: handle.sessionId,
      });
    } finally {
      entry.client.setCallbacks(null);
    }
  }

  async cancel(handle: ProcessHandle): Promise<void> {
    const entry = this.processes.get(handle.sessionId);
    if (entry) {
      await entry.conn.cancel({ sessionId: entry.acpSessionId });
    }
  }

  async close(handle: ProcessHandle): Promise<void> {
    const entry = this.processes.get(handle.sessionId);
    if (entry) {
      entry.proc.kill();
      this.processes.delete(handle.sessionId);
    }
  }

  /** Check if a process is alive. */
  has(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }
}
