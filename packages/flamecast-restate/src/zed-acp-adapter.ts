/**
 * Zed ACP (Agent Client Protocol) adapter — SDK-based stdio.
 *
 * Implements the AgentAdapter interface for communicating with Zed ACP agents
 * using the official @agentclientprotocol/sdk (ClientSideConnection + ndJsonStream).
 * For containerized agents (URL-based), connects via HTTP to a session-host relay.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §2.3
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentAdapter,
  AgentEvent,
  AgentMessage,
  AgentStartConfig,
  ConfigOption,
  PromptResult,
  SessionHandle,
} from "./adapter.js";
import { HttpJsonRpcConnection } from "./http-bridge.js";

// ─── Active connections ─────────────────────────────────────────────────────

type AcpConnection = {
  conn: acp.ClientSideConnection;
  proc: ChildProcess;
  acpSessionId: string;
  client: FlamecastClient;
};

/** Stdio-based ACP connections keyed by our sessionId. */
const sdkConnections = new Map<string, AcpConnection>();

/** HTTP bridge connections keyed by sessionId (containerized agents). */
const httpConnections = new Map<string, HttpJsonRpcConnection>();

// ─── Flamecast Client (handles agent→client callbacks) ──────────────────────

class FlamecastClient implements acp.Client {
  private eventSink: ((event: AgentEvent) => void) | null = null;
  /** Accumulated text chunks from session/update notifications (for promptSync). */
  private collectedText: string[] = [];
  private collecting = false;

  setEventSink(sink: ((event: AgentEvent) => void) | null): void {
    this.eventSink = sink;
  }

  startCollecting(): void {
    this.collectedText = [];
    this.collecting = true;
  }

  stopCollecting(): AgentMessage[] | undefined {
    this.collecting = false;
    if (this.collectedText.length === 0) return undefined;
    const text = this.collectedText.join("");
    this.collectedText = [];
    return [
      {
        role: "assistant",
        parts: [{ contentType: "text/plain", content: text }],
      },
    ];
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-approve first option (Flamecast handles permissions at the VO layer)
    const firstOption = params.options[0];
    return {
      outcome: { outcome: "selected", optionId: firstOption.optionId },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          if (this.collecting) {
            this.collectedText.push(update.content.text ?? "");
          }
          this.eventSink?.({
            type: "text",
            text: update.content.text ?? "",
            role: "assistant",
          });
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.eventSink?.({
            type: "text",
            text: update.content.text ?? "",
            role: "thinking",
          });
        }
        break;
      case "tool_call":
        this.eventSink?.({
          type: "tool",
          toolCallId: update.toolCallId,
          title: update.title,
          status: mapToolStatus(update.status),
          input: update.rawInput,
          output: update.rawOutput,
        });
        break;
      case "tool_call_update":
        this.eventSink?.({
          type: "tool",
          toolCallId: update.toolCallId,
          title: "",
          status: mapToolStatus(update.status),
          input: update.rawInput,
          output: update.rawOutput,
        });
        break;
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function toPromptInput(input: string | AgentMessage[]): acp.ContentBlock[] {
  if (typeof input === "string") {
    return [{ type: "text", text: input }];
  }
  // Flatten AgentMessage[] parts into ContentBlock[]
  const blocks: acp.ContentBlock[] = [];
  for (const msg of input) {
    for (const part of msg.parts) {
      blocks.push({ type: "text", text: part.content ?? "" });
    }
  }
  return blocks;
}

function stopReasonToStatus(
  reason: acp.StopReason,
): PromptResult["status"] {
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

// ─── Adapter ────────────────────────────────────────────────────────────────

export class ZedAcpAdapter implements AgentAdapter {
  // --- Core lifecycle ---

  async start(config: AgentStartConfig): Promise<SessionHandle> {
    const sessionId = config.sessionId ?? randomUUID();

    // If config.agent is a URL (containerized agent behind HTTP bridge),
    // connect via HttpJsonRpcConnection instead of spawning locally.
    if (
      config.agent.startsWith("http://") ||
      config.agent.startsWith("https://")
    ) {
      const conn = await HttpJsonRpcConnection.connect(config.agent);

      // Initialize the ACP session (same protocol as stdio)
      const initResult = (await conn.request("initialize", {
        capabilities: {},
        clientInfo: { name: "flamecast", version: "1.0.0" },
      })) as {
        serverInfo?: { name?: string; description?: string };
        capabilities?: Record<string, unknown>;
      };

      const sessionResult = (await conn.request("session/new", {})) as {
        id?: string;
      };

      const handle: SessionHandle = {
        sessionId: sessionResult?.id ?? sessionId,
        protocol: "zed",
        agent: {
          name:
            initResult?.serverInfo?.name ??
            config.agent.split("/").pop() ??
            "zed-agent",
          description: initResult?.serverInfo?.description,
          capabilities: initResult?.capabilities,
        },
        connection: { url: config.agent },
      };

      httpConnections.set(handle.sessionId, conn);

      conn.onExit(() => {
        httpConnections.delete(handle.sessionId);
      });

      return handle;
    }

    // Local process — spawn with provided args
    const args = config.args ?? [];
    const proc = spawn(config.agent, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
    });

    // Log stderr but don't fail
    proc.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[zed-agent-stderr] ${chunk.toString().trimEnd()}`);
    });

    // Wire up SDK: stdin/stdout → ndJsonStream → ClientSideConnection
    const stdinWeb = Writable.toWeb(proc.stdin!);
    const stdoutWeb = Readable.toWeb(
      proc.stdout! as import("node:stream").Readable,
    ) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);

    const client = new FlamecastClient();
    const connection = new acp.ClientSideConnection((_agent) => client, stream);

    // Initialize the ACP connection
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "flamecast", title: "Flamecast", version: "1.0.0" },
    });

    // Create a new session
    const sessionResult = await connection.newSession({
      cwd: config.cwd ?? process.cwd(),
      mcpServers: [],
    });

    const acpSessionId = sessionResult.sessionId;

    const handle: SessionHandle = {
      sessionId: acpSessionId ?? sessionId,
      protocol: "zed",
      agent: {
        name:
          initResult.agentInfo?.name ??
          config.agent.split("/").pop() ??
          "zed-agent",
        description: initResult.agentInfo?.title,
        capabilities: initResult.agentCapabilities as
          | Record<string, unknown>
          | undefined,
      },
      connection: { pid: proc.pid },
    };

    sdkConnections.set(handle.sessionId, {
      conn: connection,
      proc,
      acpSessionId,
      client,
    });

    // Clean up on process exit
    connection.signal.addEventListener("abort", () => {
      sdkConnections.delete(handle.sessionId);
    });

    return handle;
  }

  async cancel(session: SessionHandle): Promise<void> {
    const entry = sdkConnections.get(session.sessionId);
    if (entry) {
      await entry.conn.cancel({ sessionId: entry.acpSessionId });
      return;
    }
    const httpConn = httpConnections.get(session.sessionId);
    if (httpConn) {
      httpConn.notify("session/cancel", { sessionId: session.sessionId });
    }
  }

  async close(session: SessionHandle): Promise<void> {
    const entry = sdkConnections.get(session.sessionId);
    if (entry) {
      entry.proc.kill();
      sdkConnections.delete(session.sessionId);
      return;
    }
    const httpConn = httpConnections.get(session.sessionId);
    if (httpConn) {
      httpConn.kill();
      httpConnections.delete(session.sessionId);
    }
  }

  // --- Sync (VO handler, inside ctx.run(), journaled) ---

  async promptSync(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): Promise<PromptResult> {
    // SDK connection
    const entry = sdkConnections.get(session.sessionId);
    if (entry) {
      try {
        // Collect session/update notifications during the prompt call
        entry.client.startCollecting();
        const result = await entry.conn.prompt({
          sessionId: entry.acpSessionId,
          prompt: toPromptInput(input),
        });
        const output = entry.client.stopCollecting();

        return {
          status: stopReasonToStatus(result.stopReason),
          output,
          runId: session.sessionId,
        };
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          runId: session.sessionId,
        };
      }
    }

    // HTTP bridge fallback
    const httpConn = httpConnections.get(session.sessionId);
    if (!httpConn)
      throw new Error(`No connection for session ${session.sessionId}`);

    const messages =
      typeof input === "string"
        ? [
            {
              role: "user" as const,
              parts: [{ contentType: "text/plain", content: input }],
            },
          ]
        : input;

    try {
      const result = (await httpConn.request("session/prompt", {
        sessionId: session.sessionId,
        messages,
      })) as {
        status?: string;
        output?: AgentMessage[];
        awaitRequest?: unknown;
        error?: string;
      };

      return {
        status: (result.status as PromptResult["status"]) ?? "completed",
        output: result.output,
        awaitRequest: result.awaitRequest,
        runId: session.sessionId,
        error: result.error,
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        runId: session.sessionId,
      };
    }
  }

  async resumeSync(
    session: SessionHandle,
    _runId: string,
    payload: unknown,
  ): Promise<PromptResult> {
    // SDK connections don't have a native "resume" in ACP spec yet —
    // use extension method or fall through to HTTP
    const httpConn = httpConnections.get(session.sessionId);
    if (!httpConn)
      throw new Error(`No connection for session ${session.sessionId}`);

    try {
      const result = (await httpConn.request("session/resume", {
        sessionId: session.sessionId,
        payload,
      })) as {
        status?: string;
        output?: AgentMessage[];
        awaitRequest?: unknown;
        error?: string;
      };

      return {
        status: (result.status as PromptResult["status"]) ?? "completed",
        output: result.output,
        awaitRequest: result.awaitRequest,
        runId: session.sessionId,
        error: result.error,
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        runId: session.sessionId,
      };
    }
  }

  // --- Streaming (API layer / client-direct, not journaled) ---

  async *prompt(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): AsyncGenerator<AgentEvent> {
    // SDK connection — use FlamecastClient event sink for streaming
    const entry = sdkConnections.get(session.sessionId);
    if (entry) {
      const events: AgentEvent[] = [];
      let done = false;
      let resolve: (() => void) | null = null;

      // Get the client from the connection's closure
      // We need to create a tap into the client's sessionUpdate
      const client = new FlamecastClient();
      client.setEventSink((event) => {
        events.push(event);
        resolve?.();
      });

      // For the SDK, we can't swap the client mid-connection, so we use
      // a parallel approach: send prompt and collect notifications via the
      // existing connection, while also watching for completion.
      const promptPromise = entry.conn
        .prompt({
          sessionId: entry.acpSessionId,
          prompt: toPromptInput(input),
        })
        .then((result) => {
          done = true;
          resolve?.();
          return result;
        })
        .catch((error) => {
          done = true;
          events.push({
            type: "error",
            code: "PROMPT_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
          resolve?.();
          return null;
        });

      // Yield events as they arrive
      while (!done) {
        if (events.length > 0) {
          yield events.shift()!;
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
      // Drain remaining
      while (events.length > 0) {
        yield events.shift()!;
      }

      const result = await promptPromise;
      if (result) {
        yield {
          type: "complete",
          reason: result.stopReason === "cancelled" ? "cancelled" : "end_turn",
        };
      }
      return;
    }

    // HTTP bridge fallback — use notification-based streaming
    const httpConn = httpConnections.get(session.sessionId);
    if (!httpConn)
      throw new Error(`No connection for session ${session.sessionId}`);

    const messages =
      typeof input === "string"
        ? [
            {
              role: "user" as const,
              parts: [{ contentType: "text/plain", content: input }],
            },
          ]
        : input;

    const events: AgentEvent[] = [];
    let done = false;
    let resolve: (() => void) | null = null;

    type JsonRpcNotification = {
      jsonrpc: "2.0";
      method: string;
      params?: unknown;
    };

    const onNotification = (msg: JsonRpcNotification) => {
      if (msg.method === "session/update") {
        const params = msg.params as
          | {
              type?: string;
              text?: string;
              toolCallId?: string;
              title?: string;
              status?: string;
              input?: unknown;
              output?: unknown;
            }
          | undefined;
        if (params?.type === "text") {
          events.push({
            type: "text",
            text: params.text ?? "",
            role: "assistant",
          });
        } else if (params?.type === "tool") {
          events.push({
            type: "tool",
            toolCallId: params.toolCallId ?? "",
            title: params.title ?? "",
            status:
              (params.status as
                | "pending"
                | "running"
                | "completed"
                | "failed") ?? "running",
            input: params.input,
            output: params.output,
          });
        }
        resolve?.();
      }
    };

    httpConn.onNotification(onNotification);

    const promptPromise = httpConn
      .request("session/prompt", {
        sessionId: session.sessionId,
        messages,
      })
      .then((result) => {
        done = true;
        resolve?.();
        return result;
      })
      .catch((error) => {
        done = true;
        events.push({
          type: "error",
          code: "PROMPT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
        resolve?.();
      });

    while (!done) {
      if (events.length > 0) {
        yield events.shift()!;
      } else {
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    }
    while (events.length > 0) {
      yield events.shift()!;
    }

    httpConn.offNotification(onNotification);

    const result = await promptPromise;
    if (result) {
      const r = result as { output?: AgentMessage[] };
      yield { type: "complete", reason: "end_turn", output: r.output };
    }
  }

  async *resume(
    session: SessionHandle,
    payload: unknown,
  ): AsyncGenerator<AgentEvent> {
    const result = await this.resumeSync(session, session.sessionId, payload);
    if (result.status === "completed") {
      yield { type: "complete", reason: "end_turn", output: result.output };
    } else if (result.status === "awaiting") {
      yield { type: "pause", request: result.awaitRequest };
    } else if (result.status === "failed") {
      yield {
        type: "error",
        code: "RESUME_FAILED",
        message: result.error ?? "Resume failed",
      };
    }
  }

  // --- Config ---

  async getConfigOptions(session: SessionHandle): Promise<ConfigOption[]> {
    // SDK connections don't have a standalone "getConfigOptions" — config comes
    // from the newSession response. Return empty for now.
    const httpConn = httpConnections.get(session.sessionId);
    if (!httpConn) return [];
    try {
      const result = (await httpConn.request("session/getConfigOptions", {
        sessionId: session.sessionId,
      })) as ConfigOption[];
      return result ?? [];
    } catch {
      return [];
    }
  }

  async setConfigOption(
    session: SessionHandle,
    configId: string,
    value: string,
  ): Promise<ConfigOption[]> {
    // SDK connection — use proper ACP method
    const entry = sdkConnections.get(session.sessionId);
    if (entry) {
      try {
        const result = await entry.conn.setSessionConfigOption({
          sessionId: entry.acpSessionId,
          configId,
          value,
        } as acp.SetSessionConfigOptionRequest);
        // Map SDK config options to our ConfigOption format
        return (result.configOptions ?? []).map((opt: acp.SessionConfigOption) => ({
          id: opt.id,
          label: opt.name,
          type: opt.type === "boolean" ? "string" : "enum",
          value: String(
            "selectedValue" in opt ? opt.selectedValue : "",
          ),
          options:
            "values" in opt
              ? (
                  opt.values as Array<{ id: string; name?: string }>
                ).map((v) => v.id)
              : undefined,
        }));
      } catch {
        return [];
      }
    }

    // HTTP bridge fallback
    const httpConn = httpConnections.get(session.sessionId);
    if (!httpConn) return [];
    try {
      const result = (await httpConn.request("session/setConfigOption", {
        sessionId: session.sessionId,
        configId,
        value,
      })) as ConfigOption[];
      return result ?? [];
    } catch {
      return [];
    }
  }
}
