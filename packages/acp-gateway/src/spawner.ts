/**
 * Spawner — transport-agnostic agent process manager, keyed by runId.
 *
 * Uses AgentTransport to get a Stream, then ClientSideConnection
 * from @agentclientprotocol/sdk handles the ACP protocol.
 */

import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import type { SpawnConfig } from "./registry.js";
import type { TransportConnection } from "./transport.js";
import { StdioTransport } from "./transports/stdio.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AcpRunStatus =
  | "created"
  | "in-progress"
  | "awaiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentProcess {
  runId: string;
  agentId: string;
  transport: TransportConnection;
  conn: acp.ClientSideConnection;
  acpSessionId: string;
  status: AcpRunStatus;
  emitter: EventEmitter;
  resolvePermission?: (decision: { optionId: string }) => void;
  rejectPermission?: (err: Error) => void;
  permissionRequest?: {
    toolCallId: string;
    title: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
  };
  collectedText: string[];
  output?: Array<{
    role: string;
    parts: Array<{ contentType: string; content: string }>;
  }>;
  error?: string;
}

// ─── ACP Client (handles agent→client callbacks) ────────────────────────────

class GatewayAcpClient implements acp.Client {
  constructor(private getProcess: () => AgentProcess | undefined) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const proc = this.getProcess();
    if (!proc) {
      return {
        outcome: {
          outcome: "selected",
          optionId: params.options[0].optionId,
        },
      };
    }

    proc.status = "awaiting";
    proc.permissionRequest = {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "Permission required",
      options: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
    };

    proc.emitter.emit("event", {
      type: "run.awaiting",
      runId: proc.runId,
      awaitRequest: proc.permissionRequest,
    });

    const decision = await new Promise<{ optionId: string }>(
      (resolve, reject) => {
        proc.resolvePermission = resolve;
        proc.rejectPermission = reject;
      },
    );

    if (decision.optionId === "__cancelled__") {
      throw new acp.RequestError(-32000, "Run cancelled while awaiting");
    }

    proc.status = "in-progress";
    proc.resolvePermission = undefined;
    proc.rejectPermission = undefined;
    proc.permissionRequest = undefined;

    proc.emitter.emit("event", {
      type: "run.in-progress",
      runId: proc.runId,
    });

    return {
      outcome: { outcome: "selected", optionId: decision.optionId },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const proc = this.getProcess();
    if (!proc) return;

    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          proc.collectedText.push(update.content.text ?? "");
          proc.emitter.emit("event", {
            type: "message.part",
            runId: proc.runId,
            part: { type: "text", text: update.content.text ?? "" },
          });
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          proc.emitter.emit("event", {
            type: "message.part",
            runId: proc.runId,
            part: {
              type: "text",
              text: update.content.text ?? "",
              metadata: { role: "thinking" },
            },
          });
        }
        break;
      case "tool_call":
      case "tool_call_update":
        proc.emitter.emit("event", {
          type: "message.part",
          runId: proc.runId,
          part: {
            type: "text",
            text: `[tool: ${update.title ?? update.toolCallId}]`,
            metadata: {
              tool: true,
              toolCallId: update.toolCallId,
              status: update.status,
            },
          },
        });
        break;
    }
  }
}

// ─── Transport resolution ───────────────────────────────────────────────────

const stdioTransport = new StdioTransport();

function connectTransport(
  config: SpawnConfig,
  runId: string,
  cwd: string,
): Promise<TransportConnection> {
  const explicit = config.transport;
  const dist = config.distribution;

  if (explicit === "stdio" || (!explicit && dist.type !== "url")) {
    if (dist.type === "url") {
      throw new Error(
        `Agent "${config.id}" has url distribution but no http-sse/websocket transport configured`,
      );
    }
    return stdioTransport.connect({
      cmd: dist.cmd,
      args: dist.args,
      cwd,
      env: {
        ...(dist.type === "npx" ? dist.env : undefined),
        ...config.env,
      },
      label: `${config.id}:${runId}`,
    });
  }

  // Future: http-sse and websocket transports
  throw new Error(`Transport "${explicit}" not yet implemented`);
}

// ─── Spawner ────────────────────────────────────────────────────────────────

const processes = new Map<string, AgentProcess>();

export function getProcess(runId: string): AgentProcess | undefined {
  return processes.get(runId);
}

export async function spawnForRun(
  runId: string,
  config: SpawnConfig,
  cwd?: string,
): Promise<AgentProcess> {
  const resolvedCwd = cwd ?? process.cwd();

  // Connect via transport — gets us a Stream for ClientSideConnection
  const connection = await connectTransport(config, runId, resolvedCwd);

  const agentProcess: AgentProcess = {
    runId,
    agentId: config.id,
    transport: connection,
    conn: undefined as unknown as acp.ClientSideConnection,
    acpSessionId: "",
    status: "created",
    emitter: new EventEmitter(),
    collectedText: [],
  };

  const client = new GatewayAcpClient(() => processes.get(runId));
  const conn = new acp.ClientSideConnection((_agent) => client, connection.stream);
  agentProcess.conn = conn;

  // ACP handshake — close transport on failure
  try {
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: "acp-gateway",
        title: "ACP Gateway",
        version: "0.1.0",
      },
    });

    const sessionResult = await conn.newSession({
      cwd: resolvedCwd,
      mcpServers: [],
    });
    agentProcess.acpSessionId = sessionResult.sessionId;
  } catch (err) {
    await connection.close();
    throw err;
  }

  processes.set(runId, agentProcess);

  // Clean up on connection close
  conn.signal.addEventListener("abort", () => {
    const p = processes.get(runId);
    if (p && (p.status === "created" || p.status === "in-progress")) {
      p.status = "failed";
      p.error = "Agent connection closed unexpectedly";
      p.emitter.emit("event", {
        type: "run.failed",
        runId,
        error: p.error,
      });
    }
    processes.delete(runId);
  });

  return agentProcess;
}

export async function executeRun(
  agentProcess: AgentProcess,
  promptText: string,
): Promise<void> {
  agentProcess.status = "in-progress";
  agentProcess.collectedText = [];

  agentProcess.emitter.emit("event", {
    type: "run.created",
    runId: agentProcess.runId,
  });
  agentProcess.emitter.emit("event", {
    type: "run.in-progress",
    runId: agentProcess.runId,
  });

  try {
    const result = await agentProcess.conn.prompt({
      sessionId: agentProcess.acpSessionId,
      prompt: [{ type: "text", text: promptText }],
    });

    const collectedText = agentProcess.collectedText.join("");
    agentProcess.output = collectedText
      ? [
          {
            role: "agent",
            parts: [{ contentType: "text/plain", content: collectedText }],
          },
        ]
      : undefined;

    const status =
      result.stopReason === "cancelled"
        ? "cancelled"
        : result.stopReason === "refusal"
          ? "failed"
          : "completed";

    agentProcess.status = status as AcpRunStatus;
    agentProcess.emitter.emit("event", {
      type: `run.${status}`,
      runId: agentProcess.runId,
      output: agentProcess.output,
    });
  } catch (err) {
    agentProcess.status = "failed";
    agentProcess.error =
      err instanceof Error ? err.message : JSON.stringify(err);
    agentProcess.emitter.emit("event", {
      type: "run.failed",
      runId: agentProcess.runId,
      error: agentProcess.error,
    });
  }
}

export async function cancelRun(runId: string): Promise<boolean> {
  const p = processes.get(runId);
  if (!p) return false;

  if (p.resolvePermission) {
    p.resolvePermission({ optionId: "__cancelled__" });
    p.resolvePermission = undefined;
    p.rejectPermission = undefined;
    p.permissionRequest = undefined;
  }

  try {
    await p.conn.cancel({ sessionId: p.acpSessionId });
  } catch {
    // best-effort
  }

  p.status = "cancelled";
  p.emitter.emit("event", { type: "run.cancelled", runId });

  killProcess(runId);
  return true;
}

export async function killProcess(runId: string): Promise<void> {
  const p = processes.get(runId);
  if (!p) return;
  processes.delete(runId);
  await p.transport.close();
}
