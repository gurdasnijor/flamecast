/**
 * AcpClient — transport-agnostic multiplexing ACP client.
 *
 * Manages multiple agent sessions over any transport (stdio, ws, http-sse).
 * Pure ACP protocol — no Restate dependency.
 *
 * Usage:
 *   const client = new AcpClient({ transport });
 *   await client.warmup(["claude-acp", "codex-acp"]); // preflight init
 *   const { sessionId } = await client.connect("claude-acp", { cwd, onSessionUpdate });
 *   const result = await client.prompt(sessionId, "hello");
 */

import * as acp from "@agentclientprotocol/sdk";
import type { ByteConnection, Codec } from "./transport.js";
import { applyCodec, ndJsonCodec } from "./transport.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AcpClientConfig {
  /** Resolve an agent name to raw byte streams. */
  connect: (agentName: string) => Promise<ByteConnection>;
  /** Codec for message serialization (default: ndJsonCodec). */
  codec?: Codec<acp.AnyMessage>;
  clientInfo?: acp.InitializeRequest["clientInfo"];
  clientCapabilities?: acp.InitializeRequest["clientCapabilities"];
}

export interface AcpClientConnectOptions {
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
  mcpServers?: acp.NewSessionRequest["mcpServers"];
}

export interface AgentCapabilities {
  agentName: string;
  initResponse: acp.InitializeResponse;
}

interface ManagedSession {
  agentName: string;
  sessionId: string;
  close: () => Promise<void>;
  conn: acp.ClientSideConnection;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class AcpClient {
  private connectFn: (agentName: string) => Promise<ByteConnection>;
  private codec: Codec<acp.AnyMessage>;
  private clientInfo: acp.InitializeRequest["clientInfo"];
  private clientCapabilities: acp.InitializeRequest["clientCapabilities"];
  private sessions = new Map<string, ManagedSession>();
  private warmCache = new Map<string, AgentCapabilities>();

  constructor(config: AcpClientConfig) {
    this.connectFn = config.connect;
    this.codec = config.codec ?? ndJsonCodec();
    this.clientInfo = config.clientInfo ?? {
      name: "acp-client",
      title: "ACP Client",
      version: "0.1.0",
    };
    this.clientCapabilities = config.clientCapabilities ?? {};
  }

  // ── Warmup (preflight initialization) ────────────────────────────────

  /**
   * Preflight: connect + initialize each agent to verify reachability
   * and cache capabilities. Does NOT create sessions.
   *
   * For stdio: spawns process, runs initialize, keeps it alive.
   * For ws/http: connects, runs initialize, disconnects (agent is remote).
   */
  async warmup(
    agentNames: string[],
    opts?: { retries?: number; retryDelayMs?: number },
  ): Promise<Map<string, AgentCapabilities>> {
    const maxRetries = opts?.retries ?? 3;
    const retryDelay = opts?.retryDelayMs ?? 2000;

    await Promise.all(
      agentNames.map(async (agentName) => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const bytes = await this.connectFn(agentName);
            const stream = applyCodec(bytes, this.codec);

            // Minimal no-op client for init handshake
            const conn = new acp.ClientSideConnection(
              () => ({
                async requestPermission(params) {
                  return {
                    outcome: {
                      outcome: "selected",
                      optionId: params.options[0].optionId,
                    },
                  };
                },
                async sessionUpdate() {},
              }),
              stream,
            );

            const initResponse = await conn.initialize({
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: this.clientCapabilities ?? {},
              clientInfo: this.clientInfo,
            });

            this.warmCache.set(agentName, { agentName, initResponse });
            console.log(
              `[acp] ${agentName} warm — proto ${initResponse.protocolVersion}`,
            );

            // Close the preflight connection — connect() creates fresh ones
            await stream.close();
            return;
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : JSON.stringify(err);
            if (attempt < maxRetries) {
              console.warn(
                `[acp] ${agentName} warmup failed (${attempt}/${maxRetries}): ${msg} — retrying`,
              );
              await new Promise((r) => setTimeout(r, retryDelay));
            } else {
              console.error(
                `[acp] ${agentName} warmup failed after ${maxRetries} attempts: ${msg}`,
              );
            }
          }
        }
      }),
    );

    return new Map(this.warmCache);
  }

  /** Get cached capabilities from warmup. */
  getCapabilities(agentName: string): AgentCapabilities | undefined {
    return this.warmCache.get(agentName);
  }

  // ── Session lifecycle ────────────────────────────────────────────────

  /**
   * Connect to an agent: transport.connect → initialize → newSession.
   * Returns sessionId + agentName. Each call creates a fresh connection.
   */
  async connect(
    agentName: string,
    opts: AcpClientConnectOptions = {},
  ): Promise<{
    sessionId: string;
    agentName: string;
    initResponse: acp.InitializeResponse;
    sessionResponse: acp.NewSessionResponse;
  }> {
    const bytes = await this.connectFn(agentName);
    const stream = applyCodec(bytes, this.codec);

    const client: acp.Client = {
      async requestPermission(params) {
        if (opts.onPermissionRequest) return opts.onPermissionRequest(params);
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options[0].optionId,
          },
        };
      },
      async sessionUpdate(params) {
        opts.onSessionUpdate?.(params);
      },
      async readTextFile(params) {
        if (opts.onReadTextFile) return opts.onReadTextFile(params);
        const { readFile } = await import("node:fs/promises");
        return { content: await readFile(params.path, "utf-8") };
      },
      async writeTextFile(params) {
        if (opts.onWriteTextFile) return opts.onWriteTextFile(params);
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(params.path), { recursive: true });
        await writeFile(params.path, params.content, "utf-8");
        return {};
      },
    };

    const conn = new acp.ClientSideConnection(() => client, stream);

    const initResponse = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.clientCapabilities ?? {},
      clientInfo: this.clientInfo,
    });

    const sessionResponse = await conn.newSession({
      cwd: opts.cwd ?? process.cwd(),
      mcpServers: opts.mcpServers ?? [],
    });

    this.sessions.set(sessionResponse.sessionId, {
      agentName,
      sessionId: sessionResponse.sessionId,
      close: () => stream.close(),
      conn,
    });

    return {
      sessionId: sessionResponse.sessionId,
      agentName,
      initResponse,
      sessionResponse,
    };
  }

  // ── Prompt / Cancel / Close ──────────────────────────────────────────

  async prompt(sessionId: string, text: string): Promise<acp.PromptResponse> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`No session: ${sessionId}`);
    return s.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`No session: ${sessionId}`);
    await s.conn.cancel({ sessionId });
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    await s.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.close()));
  }

  // ── Introspection ────────────────────────────────────────────────────

  sessions_list(): Array<{ sessionId: string; agentName: string }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      agentName: s.agentName,
    }));
  }
}
