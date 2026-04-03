/**
 * NATS transport tests.
 *
 * Architecture:
 *
 *   Client (NatsTransport)                    Agent
 *     ──publish acp.{sid}.c2a──►  NATS  ◄──subscribe acp.{sid}.c2a──
 *     ◄──subscribe acp.{sid}.a2c──      ──publish acp.{sid}.a2c──►
 *
 * Both sides use core NATS pub/sub on a real nats-server.
 * Requires: nats-server (`brew install nats-server`)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { NatsTransport, createNatsAgentStream } from "../src/transports/nats.js";

// ─── NATS server lifecycle ──────────────────────────────────────────────────

let natsProc: ChildProcess;
const NATS_PORT = 14222 + Math.floor(Math.random() * 1000);

async function startNats(): Promise<void> {
  natsProc = spawn("nats-server", ["-p", String(NATS_PORT)], {
    stdio: "pipe",
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("NATS startup timeout")),
      5000,
    );
    natsProc.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Server is ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    natsProc.on("error", reject);
  });
}

// ─── Mock Agent ──────────────────────────────────────────────────────────────

class EchoAgent implements acp.Agent {
  conn: acp.AgentSideConnection | null = null;

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false },
    };
  }
  async newSession(): Promise<acp.NewSessionResponse> {
    return { sessionId: "nats-session-1" };
  }
  async authenticate(): Promise<void> {}
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const text = params.prompt
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
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

class CollectorClient implements acp.Client {
  updates: acp.SessionNotification[] = [];
  async requestPermission(params: acp.RequestPermissionRequest) {
    return { outcome: { outcome: "selected" as const, optionId: params.options[0].optionId } };
  }
  async sessionUpdate(params: acp.SessionNotification) {
    this.updates.push(params);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("NATS transport", () => {
  let clientNc: NatsConnection;
  let agentNc: NatsConnection;

  beforeAll(async () => {
    await startNats();
    clientNc = await connect({ servers: `nats://localhost:${NATS_PORT}` });
    agentNc = await connect({ servers: `nats://localhost:${NATS_PORT}` });
  }, 10_000);

  afterAll(async () => {
    await clientNc?.close();
    await agentNc?.close();
    natsProc?.kill();
  });

  it("completes ACP handshake over NATS", async () => {
    const sessionId = `s-${crypto.randomUUID().slice(0, 8)}`;
    const agent = new EchoAgent();

    // Agent side — subscribe first so it's ready when client publishes
    const agentSide = createNatsAgentStream(agentNc, sessionId);
    new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentSide.stream);

    // Small delay to let NATS subscriptions propagate
    await new Promise((r) => setTimeout(r, 50));

    // Client side
    const transport = new NatsTransport(clientNc);
    const tc = await transport.connect({ agentName: "echo", sessionId });

    const collector = new CollectorClient();
    const conn = new acp.ClientSideConnection(() => collector, tc.stream);

    const init = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test-nats", title: "Test", version: "0.0.1" },
    });
    expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);

    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
    expect(session.sessionId).toBe("nats-session-1");

    agentSide.close();
    await tc.close();
  });

  it("sends prompt and receives response over NATS", async () => {
    const sessionId = `s-${crypto.randomUUID().slice(0, 8)}`;
    const agent = new EchoAgent();

    const agentSide = createNatsAgentStream(agentNc, sessionId);
    new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentSide.stream);
    await new Promise((r) => setTimeout(r, 50));

    const transport = new NatsTransport(clientNc);
    const tc = await transport.connect({ agentName: "echo", sessionId });
    const collector = new CollectorClient();
    const conn = new acp.ClientSideConnection(() => collector, tc.stream);

    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    const result = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello nats" }],
    });
    expect(result.stopReason).toBe("end_turn");

    agentSide.close();
    await tc.close();
  });

  it("receives session updates over NATS", async () => {
    const sessionId = `s-${crypto.randomUUID().slice(0, 8)}`;
    const agent = new EchoAgent();

    const agentSide = createNatsAgentStream(agentNc, sessionId);
    new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentSide.stream);
    await new Promise((r) => setTimeout(r, 50));

    const transport = new NatsTransport(clientNc);
    const tc = await transport.connect({ agentName: "echo", sessionId });
    const collector = new CollectorClient();
    const conn = new acp.ClientSideConnection(() => collector, tc.stream);

    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "ping" }],
    });
    await new Promise((r) => setTimeout(r, 100));

    const textUpdate = collector.updates.find(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdate).toBeDefined();
    expect(
      textUpdate!.update.sessionUpdate === "agent_message_chunk" &&
        textUpdate!.update.content.type === "text"
        ? textUpdate!.update.content.text
        : undefined,
    ).toBe("echo: ping");

    agentSide.close();
    await tc.close();
  });

  it("supports multi-turn over NATS", async () => {
    const sessionId = `s-${crypto.randomUUID().slice(0, 8)}`;
    const agent = new EchoAgent();

    const agentSide = createNatsAgentStream(agentNc, sessionId);
    new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentSide.stream);
    await new Promise((r) => setTimeout(r, 50));

    const transport = new NatsTransport(clientNc);
    const tc = await transport.connect({ agentName: "echo", sessionId });
    const collector = new CollectorClient();
    const conn = new acp.ClientSideConnection(() => collector, tc.stream);

    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    const r1 = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 1" }],
    });
    expect(r1.stopReason).toBe("end_turn");

    const r2 = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    });
    expect(r2.stopReason).toBe("end_turn");

    await new Promise((r) => setTimeout(r, 100));

    const textUpdates = collector.updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdates).toHaveLength(2);

    agentSide.close();
    await tc.close();
  });
});
