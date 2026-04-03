/**
 * Gateway pattern tests — AcpClient as an ACP-to-ACP gateway.
 *
 * Runs the same gateway assertions across all three transports:
 *   1. In-memory (TransformStream pairs)
 *   2. HTTP+SSE (real HTTP server)
 *   3. WebSocket (real WS server)
 *
 * Validates that AcpClient has the components needed for a single
 * upstream ACP connection to multiplex across downstream ACP agents,
 * regardless of wire protocol.
 *
 *   Upstream Client                         Downstream Agents
 *   (ClientSideConnection)                  (via Transport)
 *         │                                       ▲
 *         ▼                                       │
 *   Gateway Agent (AgentSideConnection)     AcpClient
 *         │              │                        │
 *         └──── routes prompts ───────────────────┘
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import type { Transport, TransportConnection } from "../src/transport.js";
import { HttpSseTransport } from "../src/transports/http-sse.js";
import { WsTransport } from "../src/transports/websocket.js";
import { AcpClient } from "../src/acp-client.js";

// ─── Shared mock agent factory ──────────────────────────────────────────────

function makeAgent(name: string): {
  agent: acp.Agent;
  conn: acp.AgentSideConnection | null;
} {
  const state: {
    agent: acp.Agent;
    conn: acp.AgentSideConnection | null;
  } = {
    conn: null,
    agent: {
      async initialize(
        params: acp.InitializeRequest,
      ): Promise<acp.InitializeResponse> {
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: false },
          agentInfo: { name, title: name, version: "1.0.0" },
        };
      },
      async newSession(): Promise<acp.NewSessionResponse> {
        return { sessionId: `${name}-session` };
      },
      async authenticate(): Promise<void> {},
      async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const text = params.prompt
          .filter(
            (p): p is { type: "text"; text: string } => p.type === "text",
          )
          .map((p) => p.text)
          .join("");

        if (state.conn) {
          await state.conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `[${name}] ${text}` },
            },
          });
        }
        return { stopReason: "end_turn" };
      },
      async cancel(): Promise<void> {},
    },
  };
  return state;
}

// ─── Transport factories ────────────────────────────────────────────────────

// 1. In-memory transport
class InMemoryTransport implements Transport<{ agentName: string }> {
  private agents = new Map<string, () => ReturnType<typeof makeAgent>>();

  register(name: string, create: () => ReturnType<typeof makeAgent>) {
    this.agents.set(name, create);
  }

  async connect(opts: { agentName: string }): Promise<TransportConnection> {
    const entry = this.agents.get(opts.agentName);
    if (!entry) throw new Error(`No agent: ${opts.agentName}`);

    const ac = new AbortController();
    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();

    const clientStream = acp.ndJsonStream(
      clientToAgent.writable,
      agentToClient.readable,
    );
    const agentStream = acp.ndJsonStream(
      agentToClient.writable,
      clientToAgent.readable,
    );

    const memAgent = entry();
    new acp.AgentSideConnection((conn) => {
      memAgent.conn = conn;
      return memAgent.agent;
    }, agentStream);

    return {
      stream: clientStream,
      signal: ac.signal,
      async close() {
        ac.abort();
        await clientToAgent.writable.close().catch(() => {});
        await agentToClient.writable.close().catch(() => {});
      },
    };
  }
}

// 2. HTTP+SSE agent server
function createHttpAgent(agentFactory: () => ReturnType<typeof makeAgent>): {
  server: Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  const memAgent = agentFactory();

  let agentReadableController: ReadableStreamDefaultController<acp.AnyMessage>;
  const agentReadable = new ReadableStream<acp.AnyMessage>({
    start(controller) {
      agentReadableController = controller;
    },
  });

  const sseListeners = new Set<(msg: acp.AnyMessage) => void>();
  const agentWritable = new WritableStream<acp.AnyMessage>({
    write(msg) {
      for (const listener of sseListeners) listener(msg);
    },
  });

  new acp.AgentSideConnection(
    (conn) => {
      memAgent.conn = conn;
      return memAgent.agent;
    },
    { readable: agentReadable, writable: agentWritable },
  );

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/jsonrpc") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        agentReadableController.enqueue(
          JSON.parse(body) as acp.AnyMessage,
        );
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const listener = (msg: acp.AnyMessage) =>
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      sseListeners.add(listener);
      req.on("close", () => sseListeners.delete(listener));
      return;
    }
    res.writeHead(404).end();
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
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// 3. WebSocket agent server
function createWsAgent(agentFactory: () => ReturnType<typeof makeAgent>): {
  httpServer: Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    const memAgent = agentFactory();

    let readCtrl: ReadableStreamDefaultController<acp.AnyMessage>;
    const agentReadable = new ReadableStream<acp.AnyMessage>({
      start(c) {
        readCtrl = c;
      },
    });
    const agentWritable = new WritableStream<acp.AnyMessage>({
      write(msg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
    });

    new acp.AgentSideConnection(
      (conn) => {
        memAgent.conn = conn;
        return memAgent.agent;
      },
      { readable: agentReadable, writable: agentWritable },
    );

    ws.on("message", (data) => {
      const text =
        typeof data === "string" ? data : (data as Buffer).toString("utf-8");
      readCtrl.enqueue(JSON.parse(text) as acp.AnyMessage);
    });
    ws.on("close", () => {
      try {
        readCtrl.close();
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

// ─── Gateway agent ──────────────────────────────────────────────────────────

function createGatewayAgent(acpClient: AcpClient) {
  const sessionMap = new Map<
    string,
    { downstreamSessionId: string; agentName: string }
  >();
  const downstreamUpdates: acp.SessionNotification[] = [];

  const agent: acp.Agent = {
    async initialize(
      params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "gateway", title: "Gateway", version: "1.0.0" },
      };
    },
    async newSession(): Promise<acp.NewSessionResponse> {
      return { sessionId: `gw-${crypto.randomUUID().slice(0, 8)}` };
    },
    async authenticate(): Promise<void> {},
    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
      const text = params.prompt
        .filter(
          (p): p is { type: "text"; text: string } => p.type === "text",
        )
        .map((p) => p.text)
        .join("");

      const lines = text.split("\n");
      const agentName = lines[0].trim();
      const promptText = lines.slice(1).join("\n").trim() || agentName;

      let mapping = sessionMap.get(params.sessionId);
      if (!mapping || mapping.agentName !== agentName) {
        const handle = await acpClient.connect(agentName, {
          onSessionUpdate(update) {
            downstreamUpdates.push(update);
          },
        });
        mapping = {
          downstreamSessionId: handle.sessionId,
          agentName,
        };
        sessionMap.set(params.sessionId, mapping);
      }

      return acpClient.prompt(mapping.downstreamSessionId, promptText);
    },
    async cancel(): Promise<void> {},
  };

  return { agent, sessionMap, downstreamUpdates };
}

// ─── Helper: upstream connection ────────────────────────────────────────────

function connectUpstream(agent: acp.Agent) {
  const c2a = new TransformStream();
  const a2c = new TransformStream();

  const clientStream = acp.ndJsonStream(c2a.writable, a2c.readable);
  const agentStream = acp.ndJsonStream(a2c.writable, c2a.readable);

  new acp.AgentSideConnection((_conn) => agent, agentStream);

  return clientStream;
}

function makeUpstreamClient(stream: acp.Stream) {
  return new acp.ClientSideConnection(
    () => ({
      async requestPermission(params) {
        return {
          outcome: {
            outcome: "selected" as const,
            optionId: params.options[0].optionId,
          },
        };
      },
      async sessionUpdate() {},
    }),
    stream,
  );
}

// ─── Transport setup descriptors ────────────────────────────────────────────

interface TransportSetup {
  name: string;
  create(): Promise<{
    transport: Transport<{ agentName: string }>;
    teardown(): Promise<void>;
  }>;
}

const transportSetups: TransportSetup[] = [
  {
    name: "in-memory",
    async create() {
      const transport = new InMemoryTransport();
      transport.register("claude", () => makeAgent("claude"));
      transport.register("codex", () => makeAgent("codex"));
      return { transport, teardown: async () => {} };
    },
  },
  {
    name: "HTTP+SSE",
    async create() {
      const claudeServer = createHttpAgent(() => makeAgent("claude"));
      const codexServer = createHttpAgent(() => makeAgent("codex"));
      const claudePort = await claudeServer.start();
      const codexPort = await codexServer.start();

      const httpTransport = new HttpSseTransport();
      const transport: Transport<{ agentName: string }> = {
        async connect(opts) {
          const port =
            opts.agentName === "claude" ? claudePort : codexPort;
          return httpTransport.connect({
            url: `http://localhost:${port}`,
          });
        },
      };

      return {
        transport,
        async teardown() {
          await claudeServer.stop();
          await codexServer.stop();
        },
      };
    },
  },
  {
    name: "WebSocket",
    async create() {
      const claudeServer = createWsAgent(() => makeAgent("claude"));
      const codexServer = createWsAgent(() => makeAgent("codex"));
      const claudePort = await claudeServer.start();
      const codexPort = await codexServer.start();

      const wsTransport = new WsTransport();
      const transport: Transport<{ agentName: string }> = {
        async connect(opts) {
          const port =
            opts.agentName === "claude" ? claudePort : codexPort;
          return wsTransport.connect({
            url: `ws://localhost:${port}`,
          });
        },
      };

      return {
        transport,
        async teardown() {
          await claudeServer.stop();
          await codexServer.stop();
        },
      };
    },
  },
];

// ─── Parameterized tests ────────────────────────────────────────────────────

for (const setup of transportSetups) {
  describe(`Gateway over ${setup.name} transport`, () => {
    let acpClient: AcpClient;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      const s = await setup.create();
      acpClient = new AcpClient({ transport: s.transport });
      teardown = s.teardown;
    });

    afterEach(async () => {
      await acpClient.closeAll().catch(() => {});
      await teardown().catch(() => {});
    });

    it("upstream client initializes and creates a gateway session", async () => {
      const { agent } = createGatewayAgent(acpClient);
      const conn = makeUpstreamClient(connectUpstream(agent));

      const init = await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "upstream", title: "Upstream", version: "1.0.0" },
      });

      expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
      expect(init.agentInfo?.name).toBe("gateway");

      const session = await conn.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });
      expect(session.sessionId).toMatch(/^gw-/);
    });

    it("routes prompt to correct downstream agent", async () => {
      const { agent, downstreamUpdates } = createGatewayAgent(acpClient);
      const conn = makeUpstreamClient(connectUpstream(agent));

      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      const result = await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "claude\nhello from upstream" }],
      });

      expect(result.stopReason).toBe("end_turn");
      await new Promise((r) => setTimeout(r, 50));

      const claudeText = downstreamUpdates
        .filter(
          (u) =>
            u.update.sessionUpdate === "agent_message_chunk" &&
            u.update.content.type === "text",
        )
        .map((u) =>
          u.update.sessionUpdate === "agent_message_chunk" &&
          u.update.content.type === "text"
            ? u.update.content.text
            : "",
        );

      expect(claudeText).toContain("[claude] hello from upstream");
    });

    it("routes to different agents in same gateway session", { timeout: 30_000 }, async () => {
      const { agent, downstreamUpdates } = createGatewayAgent(acpClient);
      const conn = makeUpstreamClient(connectUpstream(agent));

      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "claude\nquestion 1" }],
      });

      await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "codex\nquestion 2" }],
      });

      await new Promise((r) => setTimeout(r, 50));

      const texts = downstreamUpdates
        .filter(
          (u) =>
            u.update.sessionUpdate === "agent_message_chunk" &&
            u.update.content.type === "text",
        )
        .map((u) =>
          u.update.sessionUpdate === "agent_message_chunk" &&
          u.update.content.type === "text"
            ? u.update.content.text
            : "",
        );

      expect(texts).toContain("[claude] question 1");
      expect(texts).toContain("[codex] question 2");
    });

    it("tracks downstream sessions via AcpClient.sessions()", async () => {
      const { agent } = createGatewayAgent(acpClient);
      const conn = makeUpstreamClient(connectUpstream(agent));

      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      expect(acpClient.sessions_list()).toHaveLength(0);

      await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "claude\nhello" }],
      });
      expect(acpClient.sessions_list()).toHaveLength(1);
      expect(acpClient.sessions_list()[0].agentName).toBe("claude");

      await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "codex\nhello" }],
      });
      expect(acpClient.sessions_list()).toHaveLength(2);
      expect(
        acpClient
          .sessions_list()
          .map((s) => s.agentName)
          .sort(),
      ).toEqual(["claude", "codex"]);
    });
  });
}
