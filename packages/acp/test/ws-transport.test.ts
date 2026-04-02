/**
 * WebSocket transport tests.
 *
 * Architecture:
 *
 *   Client (WsTransport)
 *     ──WS text frame──►  WS server  ◄──AgentSideConnection──► Mock Agent
 *     ◄──WS text frame──
 *
 * The WS server bridges between:
 *   - Client→Agent: incoming WS messages → agent's readable stream
 *   - Agent→Client: agent's writable stream → outgoing WS messages
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import * as acp from "@agentclientprotocol/sdk";
import { WsTransport } from "../src/transports/websocket.js";

// ─── Mock Agent ──────────────────────────────────────────────────────────────

class EchoAgent implements acp.Agent {
  conn: acp.AgentSideConnection | null = null;

  async initialize(
    params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(): Promise<acp.NewSessionResponse> {
    return { sessionId: "ws-session-1" };
  }

  async authenticate(): Promise<void> {}

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const text = params.prompt
      .filter(
        (p): p is acp.PromptRequest["prompt"][number] & { type: "text" } =>
          p.type === "text",
      )
      .map((p) => p.text)
      .join("");

    if (this.conn) {
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `echo: ${text}` },
        },
      });
    }

    return { stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {}
}

// ─── WebSocket Server (agent side) ──────────────────────────────────────────

/**
 * Creates a WS server that bridges JSON-RPC messages between
 * a WebSocket connection and an AgentSideConnection.
 */
function createAgentWsServer(agent: EchoAgent): {
  httpServer: Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    // Bridge: WS ↔ AgentSideConnection via stream pair
    let agentReadableController: ReadableStreamDefaultController<acp.AnyMessage>;
    const agentReadable = new ReadableStream<acp.AnyMessage>({
      start(controller) {
        agentReadableController = controller;
      },
    });

    const agentWritable = new WritableStream<acp.AnyMessage>({
      write(msg) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      },
    });

    const agentStream: acp.Stream = {
      readable: agentReadable,
      writable: agentWritable,
    };

    const _agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    ws.on("message", (data) => {
      const text =
        typeof data === "string" ? data : (data as Buffer).toString("utf-8");
      const msg = JSON.parse(text) as acp.AnyMessage;
      agentReadableController.enqueue(msg);
    });

    ws.on("close", () => {
      try {
        agentReadableController.close();
      } catch {
        // already closed
      }
    });
  });

  return {
    httpServer,
    async start() {
      return new Promise<number>((resolve) => {
        httpServer.listen(0, () => {
          const addr = httpServer.address();
          resolve(typeof addr === "object" ? addr!.port : 0);
        });
      });
    },
    async stop() {
      wss.close();
      return new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ─── Collector Client ────────────────────────────────────────────────────────

class CollectorClient implements acp.Client {
  updates: acp.SessionNotification[] = [];

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: { outcome: "selected", optionId: params.options[0].optionId },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("WebSocket transport", () => {
  let agent: EchoAgent;
  let serverHandle: ReturnType<typeof createAgentWsServer>;
  let port: number;
  const transport = new WsTransport();

  beforeEach(async () => {
    agent = new EchoAgent();
    serverHandle = createAgentWsServer(agent);
    port = await serverHandle.start();
  });

  afterEach(async () => {
    await serverHandle.stop();
  });

  it("completes handshake over WebSocket", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `ws://localhost:${port}` });

    const clientConn = new acp.ClientSideConnection(() => client, conn.stream);

    const initResult = await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test-ws", title: "Test", version: "0.0.1" },
    });

    expect(initResult.protocolVersion).toBe(acp.PROTOCOL_VERSION);

    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    expect(session.sessionId).toBe("ws-session-1");

    await conn.close();
  });

  it("sends prompt and receives response over WebSocket", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `ws://localhost:${port}` });
    const clientConn = new acp.ClientSideConnection(() => client, conn.stream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    const result = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello ws" }],
    });

    expect(result.stopReason).toBe("end_turn");

    await conn.close();
  });

  it("receives session update notifications", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `ws://localhost:${port}` });
    const clientConn = new acp.ClientSideConnection(() => client, conn.stream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "ping" }],
    });

    await new Promise((r) => setTimeout(r, 50));

    const textUpdate = client.updates.find(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdate).toBeDefined();
    expect(
      textUpdate!.update.sessionUpdate === "agent_message_chunk" &&
        textUpdate!.update.content.type === "text"
        ? textUpdate!.update.content.text
        : undefined,
    ).toBe("echo: ping");

    await conn.close();
  });

  it("supports multi-turn over WebSocket", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `ws://localhost:${port}` });
    const clientConn = new acp.ClientSideConnection(() => client, conn.stream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    const r1 = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 1" }],
    });
    expect(r1.stopReason).toBe("end_turn");

    const r2 = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    });
    expect(r2.stopReason).toBe("end_turn");

    await new Promise((r) => setTimeout(r, 50));

    const textUpdates = client.updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdates).toHaveLength(2);

    await conn.close();
  });

  it("signals when connection closes", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `ws://localhost:${port}` });
    const clientConn = new acp.ClientSideConnection(() => client, conn.stream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    expect(conn.signal.aborted).toBe(false);

    await conn.close();

    // Give the close event time to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.signal.aborted).toBe(true);
  });
});
