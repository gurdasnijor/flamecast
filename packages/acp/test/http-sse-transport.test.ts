/**
 * HTTP+SSE transport tests.
 *
 * Architecture:
 *
 *   Client (HttpSseTransport)
 *     ──POST /jsonrpc──►  HTTP server  ◄──AgentSideConnection──► Mock Agent
 *     ◄──SSE /events────
 *
 * The HTTP server bridges between:
 *   - Client→Agent: POST /jsonrpc bodies → agent's writable stream
 *   - Agent→Client: agent's readable stream → SSE /events
 *
 * This validates that the transport abstraction works over HTTP+SSE
 * by running the same protocol-level assertions as transport.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import * as acp from "@agentclientprotocol/sdk";
import { HttpSseTransport } from "../src/transports/http-sse.js";

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
    return { sessionId: "http-session-1" };
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

// ─── HTTP+SSE Server (agent side) ────────────────────────────────────────────

/**
 * Creates a minimal HTTP server that bridges JSON-RPC over HTTP+SSE
 * to an AgentSideConnection.
 *
 * - POST /jsonrpc — client sends JSON-RPC messages (requests/notifications)
 * - GET /events — SSE stream of JSON-RPC messages from agent
 *
 * This is the server-side counterpart to HttpSseTransport.
 */
function createAgentHttpServer(agent: EchoAgent): {
  server: Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  let agentReadableController: ReadableStreamDefaultController<acp.AnyMessage>;
  const agentReadable = new ReadableStream<acp.AnyMessage>({
    start(controller) {
      agentReadableController = controller;
    },
  });

  const sseListeners = new Set<(msg: acp.AnyMessage) => void>();
  const agentWritable = new WritableStream<acp.AnyMessage>({
    write(msg) {
      for (const listener of sseListeners) {
        listener(msg);
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

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/jsonrpc") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const msg = JSON.parse(body) as acp.AnyMessage;
        agentReadableController.enqueue(msg);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const listener = (msg: acp.AnyMessage) => {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      };
      sseListeners.add(listener);

      req.on("close", () => {
        sseListeners.delete(listener);
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return {
    server,
    async start() {
      return new Promise<number>((resolve) => {
        server.listen(0, () => {
          const addr = server.address();
          resolve(typeof addr === "object" ? addr!.port : 0);
        });
      });
    },
    async stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
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

describe("HTTP+SSE transport", () => {
  let agent: EchoAgent;
  let serverHandle: ReturnType<typeof createAgentHttpServer>;
  let port: number;
  const transport = new HttpSseTransport();

  beforeEach(async () => {
    agent = new EchoAgent();
    serverHandle = createAgentHttpServer(agent);
    port = await serverHandle.start();
  });

  afterEach(async () => {
    await serverHandle.stop();
  });

  it("completes handshake over HTTP+SSE", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `http://localhost:${port}` });

    const clientConn = new acp.ClientSideConnection(() => client, conn.stream);

    const initResult = await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test-http", title: "Test", version: "0.0.1" },
    });

    expect(initResult.protocolVersion).toBe(acp.PROTOCOL_VERSION);

    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    expect(session.sessionId).toBe("http-session-1");

    await conn.close();
  });

  it("sends prompt and receives response over HTTP+SSE", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `http://localhost:${port}` });
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
      prompt: [{ type: "text", text: "hello http" }],
    });

    expect(result.stopReason).toBe("end_turn");

    await conn.close();
  });

  it("receives session update notifications over SSE", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `http://localhost:${port}` });
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

  it("supports multi-turn over HTTP+SSE", async () => {
    const client = new CollectorClient();
    const conn = await transport.connect({ url: `http://localhost:${port}` });
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
});
