/**
 * Transport comparison — measures encoding overhead, wire size,
 * and full protocol round-trip latency across all transports.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { HttpSseTransport } from "../src/transports/http-sse.js";
import { WsTransport } from "../src/transports/websocket.js";
import {
  ProtobufWsTransport,
  loadProto,
  jsonRpcToProto,
  protoToJsonRpc,
} from "../src/transports/protobuf.js";
import { NatsTransport, createNatsAgentStream } from "../src/transports/nats.js";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";

// ─── Shared agent factory ───────────────────────────────────────────────────

function makeEchoAgent(): {
  agent: acp.Agent;
  conn: acp.AgentSideConnection | null;
} {
  const state: { agent: acp.Agent; conn: acp.AgentSideConnection | null } = {
    conn: null,
    agent: {
      async initialize(params: acp.InitializeRequest) {
        return { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: false } };
      },
      async newSession() { return { sessionId: "bench-session" }; },
      async authenticate() {},
      async prompt(params: acp.PromptRequest) {
        const text = params.prompt
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text).join("");
        if (state.conn) {
          await state.conn.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        }
        return { stopReason: "end_turn" };
      },
      async cancel() {},
    },
  };
  return state;
}

const noopClient = () => ({
  async requestPermission(p: acp.RequestPermissionRequest) {
    return { outcome: { outcome: "selected" as const, optionId: p.options[0].optionId } };
  },
  async sessionUpdate() {},
});

// ─── Server factories ───────────────────────────────────────────────────────

function createJsonWsServer() {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    const m = makeEchoAgent();
    let rc: ReadableStreamDefaultController<acp.AnyMessage>;
    const r = new ReadableStream<acp.AnyMessage>({ start(c) { rc = c; } });
    const w = new WritableStream<acp.AnyMessage>({
      write(msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
    });
    new acp.AgentSideConnection((c) => { m.conn = c; return m.agent; }, { readable: r, writable: w });
    ws.on("message", (d) => rc.enqueue(JSON.parse(typeof d === "string" ? d : (d as Buffer).toString())));
    ws.on("close", () => { try { rc.close(); } catch {} });
  });
  return {
    httpServer,
    async start() {
      return new Promise<number>((resolve) => {
        httpServer.listen(0, () => { const a = httpServer.address(); resolve(typeof a === "object" ? a!.port : 0); });
      });
    },
    async stop() { wss.close(); return new Promise<void>((r, j) => httpServer.close((e) => e ? j(e) : r())); },
  };
}

function createProtoWsServer() {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    const m = makeEchoAgent();
    let rc: ReadableStreamDefaultController<acp.AnyMessage>;
    const r = new ReadableStream<acp.AnyMessage>({ start(c) { rc = c; } });
    const w = new WritableStream<acp.AnyMessage>({
      write(msg) { if (ws.readyState === WebSocket.OPEN) ws.send(jsonRpcToProto(msg as acp.AnyMessage & Record<string, unknown>)); },
    });
    new acp.AgentSideConnection((c) => { m.conn = c; return m.agent; }, { readable: r, writable: w });
    ws.on("message", (d) => rc.enqueue(protoToJsonRpc(d instanceof Uint8Array ? d : new Uint8Array(d as Buffer))));
    ws.on("close", () => { try { rc.close(); } catch {} });
  });
  return {
    httpServer,
    async start() {
      return new Promise<number>((resolve) => {
        httpServer.listen(0, () => { const a = httpServer.address(); resolve(typeof a === "object" ? a!.port : 0); });
      });
    },
    async stop() { wss.close(); return new Promise<void>((r, j) => httpServer.close((e) => e ? j(e) : r())); },
  };
}

function createHttpSseServer() {
  const m = makeEchoAgent();
  let arc: ReadableStreamDefaultController<acp.AnyMessage>;
  const ar = new ReadableStream<acp.AnyMessage>({ start(c) { arc = c; } });
  const listeners = new Set<(msg: acp.AnyMessage) => void>();
  const aw = new WritableStream<acp.AnyMessage>({ write(msg) { for (const l of listeners) l(msg); } });
  new acp.AgentSideConnection((c) => { m.conn = c; return m.agent; }, { readable: ar, writable: aw });

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/jsonrpc") {
      let body = "";
      req.on("data", (c: Buffer) => body += c.toString());
      req.on("end", () => { arc.enqueue(JSON.parse(body)); res.writeHead(202).end('{"ok":true}'); });
      return;
    }
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const l = (msg: acp.AnyMessage) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
      listeners.add(l);
      req.on("close", () => listeners.delete(l));
      return;
    }
    res.writeHead(404).end();
  });

  return {
    server,
    async start() {
      return new Promise<number>((resolve) => {
        server.listen(0, () => { const a = server.address(); resolve(typeof a === "object" ? a!.port : 0); });
      });
    },
    async stop() { return new Promise<void>((r, j) => server.close((e) => e ? j(e) : r())); },
  };
}

// ─── Encoding benchmarks ────────────────────────────────────────────────────

describe("Encoding size comparison", () => {
  beforeAll(async () => { await loadProto(); });

  const messages: Record<string, Record<string, unknown>> = {
    "prompt response (small)": { jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } },
    "prompt request (short)": { jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: "abc", prompt: [{ type: "text", text: "hello world" }] } },
    "session update notification": { jsonrpc: "2.0", method: "notifications/sessionUpdate", params: { sessionId: "abc", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here is my analysis..." } } } },
    "prompt request (1KB payload)": { jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId: "abc", prompt: [{ type: "text", text: "x".repeat(1024) }] } },
    "prompt request (4KB payload)": { jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: "abc", prompt: [{ type: "text", text: "x".repeat(4096) }] } },
  };

  for (const [name, msg] of Object.entries(messages)) {
    it(`${name}`, () => {
      const jsonB = new TextEncoder().encode(JSON.stringify(msg));
      const protoB = jsonRpcToProto(msg as acp.AnyMessage & Record<string, unknown>);
      const pct = ((protoB.length / jsonB.length) * 100).toFixed(0);
      console.log(`  ${name.padEnd(35)} JSON=${String(jsonB.length).padStart(5)}B  Proto=${String(protoB.length).padStart(5)}B  (${pct}%)`);
      // round-trip check
      const decoded = protoToJsonRpc(protoB);
      if (msg.id !== undefined) expect(decoded.id).toBe(msg.id);
    });
  }
});

describe("Encoding throughput (10k round-trips)", () => {
  beforeAll(async () => { await loadProto(); });
  const N = 10_000;
  const msg = { jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: "abc", prompt: [{ type: "text", text: "hello world" }] } } as acp.AnyMessage & Record<string, unknown>;

  it("JSON", () => {
    const t = performance.now();
    for (let i = 0; i < N; i++) { JSON.parse(JSON.stringify(msg)); }
    const ms = performance.now() - t;
    console.log(`  JSON:  ${N} ops in ${ms.toFixed(1)}ms  (${(ms / N * 1000).toFixed(1)}µs/op)`);
  });

  it("Protobuf", () => {
    const t = performance.now();
    for (let i = 0; i < N; i++) { protoToJsonRpc(jsonRpcToProto(msg)); }
    const ms = performance.now() - t;
    console.log(`  Proto: ${N} ops in ${ms.toFixed(1)}ms  (${(ms / N * 1000).toFixed(1)}µs/op)`);
  });
});

// ─── Full protocol round-trip benchmarks ────────────────────────────────────

describe("Full protocol round-trip (50 prompt turns)", () => {
  // Servers
  let jsonWsServer: ReturnType<typeof createJsonWsServer>;
  let protoWsServer: ReturnType<typeof createProtoWsServer>;
  let httpSseServer: ReturnType<typeof createHttpSseServer>;
  let jsonWsPort: number;
  let protoWsPort: number;
  let httpSsePort: number;

  // NATS
  let natsProc: ChildProcess;
  let natsPort: number;
  let clientNc: NatsConnection;
  let agentNc: NatsConnection;

  beforeAll(async () => {
    await loadProto();

    // Start WS + HTTP servers
    jsonWsServer = createJsonWsServer();
    protoWsServer = createProtoWsServer();
    httpSseServer = createHttpSseServer();
    jsonWsPort = await jsonWsServer.start();
    protoWsPort = await protoWsServer.start();
    httpSsePort = await httpSseServer.start();

    // Start NATS
    natsPort = 14222 + Math.floor(Math.random() * 1000);
    natsProc = spawn("nats-server", ["-p", String(natsPort)], { stdio: "pipe" });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("NATS timeout")), 5000);
      natsProc.stderr?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("Server is ready")) { clearTimeout(timeout); resolve(); }
      });
      natsProc.on("error", reject);
    });
    clientNc = await connect({ servers: `nats://localhost:${natsPort}` });
    agentNc = await connect({ servers: `nats://localhost:${natsPort}` });
  }, 15_000);

  afterAll(async () => {
    await clientNc?.close();
    await agentNc?.close();
    natsProc?.kill();
    await jsonWsServer?.stop();
    await protoWsServer?.stop();
    await httpSseServer?.stop();
  });

  const TURNS = 50;

  async function bench(
    name: string,
    setup: () => Promise<{ conn: acp.ClientSideConnection; close: () => Promise<void> }>,
  ) {
    const { conn, close } = await setup();
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    const start = performance.now();
    for (let i = 0; i < TURNS; i++) {
      await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: `turn ${i}` }] });
    }
    const ms = performance.now() - start;
    await close();
    console.log(`  ${name.padEnd(20)} ${TURNS} turns in ${ms.toFixed(1).padStart(8)}ms  (${(ms / TURNS).toFixed(2)}ms/turn)`);
    return ms;
  }

  // In-memory baseline
  it("In-memory (baseline)", async () => {
    await bench("In-memory", async () => {
      const m = makeEchoAgent();
      const c2a = new TransformStream();
      const a2c = new TransformStream();
      const clientStream = acp.ndJsonStream(c2a.writable, a2c.readable);
      const agentStream = acp.ndJsonStream(a2c.writable, c2a.readable);
      new acp.AgentSideConnection((c) => { m.conn = c; return m.agent; }, agentStream);
      const conn = new acp.ClientSideConnection(noopClient, clientStream);
      return { conn, close: async () => {} };
    });
  });

  it("JSON WebSocket", async () => {
    const ws = new WsTransport();
    await bench("JSON WS", async () => {
      const tc = await ws.connect({ url: `ws://localhost:${jsonWsPort}` });
      const conn = new acp.ClientSideConnection(noopClient, tc.stream);
      return { conn, close: () => tc.close() };
    });
  });

  it("Protobuf WebSocket", async () => {
    const pb = new ProtobufWsTransport();
    await bench("Protobuf WS", async () => {
      const tc = await pb.connect({ url: `ws://localhost:${protoWsPort}` });
      const conn = new acp.ClientSideConnection(noopClient, tc.stream);
      return { conn, close: () => tc.close() };
    });
  });

  it("HTTP+SSE", async () => {
    const http = new HttpSseTransport();
    await bench("HTTP+SSE", async () => {
      const tc = await http.connect({ url: `http://localhost:${httpSsePort}` });
      const conn = new acp.ClientSideConnection(noopClient, tc.stream);
      return { conn, close: () => tc.close() };
    });
  });

  it("NATS", async () => {
    const sessionId = `bench-${crypto.randomUUID().slice(0, 8)}`;
    const agentSide = createNatsAgentStream(agentNc, sessionId);
    const m = makeEchoAgent();
    new acp.AgentSideConnection((c) => { m.conn = c; return m.agent; }, agentSide.stream);
    await new Promise((r) => setTimeout(r, 50));

    const transport = new NatsTransport(clientNc);
    await bench("NATS", async () => {
      const tc = await transport.connect({ agentName: "echo", sessionId });
      const conn = new acp.ClientSideConnection(noopClient, tc.stream);
      return { conn, close: async () => { agentSide.close(); await tc.close(); } };
    });
  });
});
