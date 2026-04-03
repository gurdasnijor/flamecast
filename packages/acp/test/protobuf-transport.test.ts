/**
 * Protobuf transport tests.
 *
 * Architecture:
 *
 *   Client (ProtobufWsTransport)
 *     ──WS binary (protobuf)──►  WS server  ◄──AgentSideConnection──► Mock Agent
 *     ◄──WS binary (protobuf)──
 *
 * The WS server decodes protobuf frames from the client, feeds them
 * to an AgentSideConnection as JSON-RPC objects, and encodes agent
 * responses back to protobuf for the client.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import {
  ProtobufWsTransport,
  loadProto,
  jsonRpcToProto,
  protoToJsonRpc,
} from "../src/transports/protobuf.js";

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
    return { sessionId: "proto-session-1" };
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

// ─── Protobuf WS Server (agent side) ────────────────────────────────────────

/**
 * WS server that speaks protobuf binary frames.
 * Decodes protobuf → JSON-RPC → AgentSideConnection → JSON-RPC → protobuf.
 */
function createProtobufWsServer(agent: EchoAgent): {
  httpServer: Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    let agentReadCtrl: ReadableStreamDefaultController<acp.AnyMessage>;
    const agentReadable = new ReadableStream<acp.AnyMessage>({
      start(c) {
        agentReadCtrl = c;
      },
    });

    const agentWritable = new WritableStream<acp.AnyMessage>({
      write(msg) {
        if (ws.readyState === WebSocket.OPEN) {
          // Encode agent→client as protobuf
          const buf = jsonRpcToProto(
            msg as acp.AnyMessage & Record<string, unknown>,
          );
          ws.send(buf);
        }
      },
    });

    new acp.AgentSideConnection(
      (conn) => {
        agent.conn = conn;
        return agent;
      },
      { readable: agentReadable, writable: agentWritable },
    );

    ws.on("message", (data) => {
      // Decode client→agent from protobuf
      const buf =
        data instanceof Uint8Array
          ? data
          : new Uint8Array(data as Buffer);
      const msg = protoToJsonRpc(buf);
      agentReadCtrl.enqueue(msg);
    });

    ws.on("close", () => {
      try {
        agentReadCtrl.close();
      } catch {}
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
      return new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
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

describe("Protobuf transport", () => {
  let agent: EchoAgent;
  let serverHandle: ReturnType<typeof createProtobufWsServer>;
  let port: number;
  const transport = new ProtobufWsTransport();

  beforeAll(async () => {
    await loadProto();
  });

  beforeEach(async () => {
    agent = new EchoAgent();
    serverHandle = createProtobufWsServer(agent);
    port = await serverHandle.start();
  });

  afterEach(async () => {
    await serverHandle.stop();
  });

  // ── Codec unit tests ────────────────────────────────────────────────────

  it("round-trips a JSON-RPC request through protobuf encoding", () => {
    const original = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", clientCapabilities: {} },
    };

    const encoded = jsonRpcToProto(original);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = protoToJsonRpc(encoded);
    expect(decoded.id).toBe(1);
    expect(decoded.method).toBe("initialize");
    expect(decoded.params).toEqual(original.params);
  });

  it("round-trips a JSON-RPC response through protobuf encoding", () => {
    const original = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { protocolVersion: "2025-03-26", agentCapabilities: {} },
    };

    const decoded = protoToJsonRpc(jsonRpcToProto(original));
    expect(decoded.id).toBe(1);
    expect(decoded.result).toEqual(original.result);
    expect(decoded.method).toBeFalsy();
  });

  it("round-trips a JSON-RPC notification (no id)", () => {
    const original = {
      jsonrpc: "2.0" as const,
      method: "notifications/sessionUpdate",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
    };

    const decoded = protoToJsonRpc(jsonRpcToProto(original));
    expect(decoded.id).toBeUndefined();
    expect(decoded.method).toBe("notifications/sessionUpdate");
    expect(decoded.params).toEqual(original.params);
  });

  // ── Protocol tests over real WS ─────────────────────────────────────────

  it("completes ACP handshake over protobuf WS", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({
      url: `ws://localhost:${port}`,
    });

    const clientConn = new acp.ClientSideConnection(
      () => client,
      conn.stream,
    );

    const initResult = await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: "test-proto",
        title: "Test",
        version: "0.0.1",
      },
    });

    expect(initResult.protocolVersion).toBe(acp.PROTOCOL_VERSION);

    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    expect(session.sessionId).toBe("proto-session-1");
    await conn.close();
  });

  it("sends prompt and receives response over protobuf WS", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({
      url: `ws://localhost:${port}`,
    });
    const clientConn = new acp.ClientSideConnection(
      () => client,
      conn.stream,
    );

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
      prompt: [{ type: "text", text: "hello protobuf" }],
    });

    expect(result.stopReason).toBe("end_turn");
    await conn.close();
  });

  it("receives session update notifications over protobuf WS", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({
      url: `ws://localhost:${port}`,
    });
    const clientConn = new acp.ClientSideConnection(
      () => client,
      conn.stream,
    );

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

  it("supports multi-turn over protobuf WS", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({
      url: `ws://localhost:${port}`,
    });
    const clientConn = new acp.ClientSideConnection(
      () => client,
      conn.stream,
    );

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
    const conn = await transport.connect({
      url: `ws://localhost:${port}`,
    });
    const clientConn = new acp.ClientSideConnection(
      () => client,
      conn.stream,
    );

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    expect(conn.signal.aborted).toBe(false);
    await conn.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.signal.aborted).toBe(true);
  });
});
