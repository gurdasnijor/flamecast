/**
 * AcpClient — transport-agnostic multiplexing ACP client.
 *
 * Manages multiple agent sessions, each backed by its own
 * TransportConnection → ClientSideConnection. The transport is
 * pluggable (stdio, HTTP+SSE, WS, in-memory).
 *
 * Usage:
 *
 *   const client = new AcpClient({ transport });
 *
 *   const session = await client.connect("claude-acp", {
 *     onSessionUpdate: (update) => console.log(update),
 *     onPermissionRequest: async (params) => ({
 *       outcome: { outcome: "selected", optionId: "allow" },
 *     }),
 *   });
 *
 *   const result = await client.prompt(session.sessionId, "hello");
 *   await client.close(session.sessionId);
 */

import * as acp from "@agentclientprotocol/sdk";
import type { Transport, TransportConnection } from "./transport.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConnectOptions {
  onSessionUpdate?: (update: acp.SessionNotification) => void;
  onPermissionRequest?: (
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  onReadTextFile?: (
    params: acp.ReadTextFileRequest,
  ) => Promise<acp.ReadTextFileResponse>;
  onWriteTextFile?: (
    params: acp.WriteTextFileRequest,
  ) => Promise<acp.WriteTextFileResponse>;
  cwd?: string;
}

export type SessionHandle = acp.InitializeResponse & acp.NewSessionResponse;

interface ManagedSession {
  agentName: string;
  handle: SessionHandle;
  transport: TransportConnection;
  conn: acp.ClientSideConnection;
  options: ConnectOptions;
}

// ─── AcpClient ──────────────────────────────────────────────────────────────

export class AcpClient {
  private transport: Transport<{ agentName: string }>;
  private sessionsBySessionId = new Map<string, ManagedSession>();

  constructor(opts: { transport: Transport<{ agentName: string }> }) {
    this.transport = opts.transport;
  }

  async connect(
    agentName: string,
    opts: ConnectOptions = {},
  ): Promise<SessionHandle> {
    const transport = await this.transport.connect({ agentName });

    const client: acp.Client = {
      async requestPermission(
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> {
        if (opts.onPermissionRequest) {
          return opts.onPermissionRequest(params);
        }
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options[0].optionId,
          },
        };
      },

      async sessionUpdate(
        params: acp.SessionNotification,
      ): Promise<void> {
        opts.onSessionUpdate?.(params);
      },

      async readTextFile(
        params: acp.ReadTextFileRequest,
      ): Promise<acp.ReadTextFileResponse> {
        if (opts.onReadTextFile) {
          return opts.onReadTextFile(params);
        }
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(params.path, "utf-8");
        return { content };
      },

      async writeTextFile(
        params: acp.WriteTextFileRequest,
      ): Promise<acp.WriteTextFileResponse> {
        if (opts.onWriteTextFile) {
          return opts.onWriteTextFile(params);
        }
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(params.path), { recursive: true });
        await writeFile(params.path, params.content, "utf-8");
        return {};
      },
    };

    const conn = new acp.ClientSideConnection(() => client, transport.stream);

    try {
      const initResponse = await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
        clientInfo: {
          name: "acp-client",
          title: "ACP Client",
          version: "0.1.0",
        },
      });

      const session = await conn.newSession({
        cwd: opts.cwd ?? process.cwd(),
        mcpServers: [],
      });

      const handle: SessionHandle = {
        ...initResponse,
        ...session,
      };

      const managed: ManagedSession = {
        agentName,
        handle,
        transport,
        conn,
        options: opts,
      };

      this.sessionsBySessionId.set(session.sessionId, managed);

      return handle;
    } catch (err) {
      await transport.close();
      throw err;
    }
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<acp.PromptResponse> {
    const session = this.sessionsBySessionId.get(sessionId);
    if (!session) {
      throw new Error(`No active session: ${sessionId}`);
    }

    return session.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessionsBySessionId.get(sessionId);
    if (!session) {
      throw new Error(`No active session: ${sessionId}`);
    }

    await session.conn.cancel({ sessionId });
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessionsBySessionId.get(sessionId);
    if (!session) return;

    this.sessionsBySessionId.delete(sessionId);
    await session.transport.close();
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessionsBySessionId.values()];
    this.sessionsBySessionId.clear();
    await Promise.all(sessions.map((s) => s.transport.close()));
  }

  sessions(): SessionHandle[] {
    return [...this.sessionsBySessionId.values()].map((s) => s.handle);
  }
}
