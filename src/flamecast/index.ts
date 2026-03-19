import type { ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import {
  createExampleAgentProcess,
  getAgentTransport,
  startCodexAgentProcess,
} from "./transport.js";

export type AgentType = "codex" | "example";

export interface ConnectionLog {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ConnectionInfo {
  id: string;
  agentType: AgentType;
  sessionId: string;
  startedAt: Date;
  lastUpdatedAt: Date;
  logs: ConnectionLog[];
}

interface ManagedConnection {
  info: ConnectionInfo;
  connection: acp.ClientSideConnection | null;
  agentProcess: ChildProcess;
}

export class Flamecast {
  private connections = new Map<string, ManagedConnection>();
  private nextId = 1;

  async create(
    opts: {
      agent?: AgentType;
      cwd?: string;
    } = {},
  ): Promise<ConnectionInfo> {
    const { agent = "example", cwd = process.cwd() } = opts;
    const id = String(this.nextId++);
    const now = new Date();

    const agentProcess = agent === "codex" ? startCodexAgentProcess() : createExampleAgentProcess();

    const { input, output } = getAgentTransport(agentProcess);
    const stream = acp.ndJsonStream(input, output);

    const managed: ManagedConnection = {
      info: {
        id,
        agentType: agent,
        sessionId: "",
        startedAt: now,
        lastUpdatedAt: now,
        logs: [],
      },
      connection: null,
      agentProcess,
    };

    const client = this.createClient(managed);
    const connection = new acp.ClientSideConnection((_agent) => client, stream);
    managed.connection = connection;

    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    this.pushLog(managed, "initialized", {
      protocolVersion: initResult.protocolVersion,
    });

    const sessionResult = await connection.newSession({
      cwd,
      mcpServers: [],
    });

    managed.info.sessionId = sessionResult.sessionId;
    this.pushLog(managed, "session_created", {
      sessionId: sessionResult.sessionId,
    });

    this.connections.set(id, managed);
    return this.snapshotInfo(managed);
  }

  list(): ConnectionInfo[] {
    return [...this.connections.values()].map((m) => this.snapshotInfo(m));
  }

  get(id: string): ConnectionInfo {
    return this.snapshotInfo(this.resolve(id));
  }

  async prompt(id: string, text: string): Promise<acp.PromptResponse> {
    const managed = this.resolve(id);
    if (!managed.connection) {
      throw new Error(`Connection "${id}" is not initialized`);
    }
    this.pushLog(managed, "prompt_sent", { text });

    const result = await managed.connection.prompt({
      sessionId: managed.info.sessionId,
      prompt: [{ type: "text", text }],
    });

    this.pushLog(managed, "prompt_completed", {
      stopReason: result.stopReason,
    });
    return result;
  }

  kill(id: string): void {
    const managed = this.resolve(id);
    managed.agentProcess.kill();
    this.pushLog(managed, "killed", {});
    this.connections.delete(id);
  }

  private resolve(id: string): ManagedConnection {
    const managed = this.connections.get(id);
    if (!managed) {
      throw new Error(`Connection "${id}" not found`);
    }
    return managed;
  }

  private snapshotInfo(managed: ManagedConnection): ConnectionInfo {
    return { ...managed.info, logs: [...managed.info.logs] };
  }

  private pushLog(managed: ManagedConnection, type: string, data: Record<string, unknown>): void {
    const now = new Date();
    managed.info.lastUpdatedAt = now;
    managed.info.logs.push({ timestamp: now.toISOString(), type, data });
  }

  private createClient(managed: ManagedConnection): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        const update = params.update;
        const entry: Record<string, unknown> = {
          sessionUpdate: update.sessionUpdate,
        };

        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            entry.content = update.content;
            break;
          case "tool_call":
            entry.toolCallId = update.toolCallId;
            entry.title = update.title;
            entry.kind = update.kind;
            entry.status = update.status;
            break;
          case "tool_call_update":
            entry.toolCallId = update.toolCallId;
            entry.status = update.status;
            break;
          case "plan":
            entry.plan = update;
            break;
          default:
            entry.raw = update;
            break;
        }

        this.pushLog(managed, "session_update", entry);
      },

      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        this.pushLog(managed, "permission_requested", {
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title,
          options: params.options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind,
          })),
        });
        const firstAllow = params.options.find((o) => o.kind === "allow_once");
        return {
          outcome: {
            outcome: "selected",
            optionId: firstAllow?.optionId ?? params.options[0].optionId,
          },
        };
      },

      readTextFile: async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
        this.pushLog(managed, "read_text_file", { path: params.path });
        return { content: "" };
      },

      writeTextFile: async (
        params: acp.WriteTextFileRequest,
      ): Promise<acp.WriteTextFileResponse> => {
        this.pushLog(managed, "write_text_file", {
          path: params.path,
        });
        return {};
      },
    };
  }
}
