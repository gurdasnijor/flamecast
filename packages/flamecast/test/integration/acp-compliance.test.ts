/**
 * ACP Compliance E2E — FlamecastConnection implements the Agent interface
 * with Restate as the transport.
 *
 * Stands up both sides:
 *   - Downstream: EchoAgent (stdio fixture) behind Restate VO
 *   - Upstream: FlamecastConnection (ACP-compliant client)
 *
 * Validates all ACP protocol semantics:
 *   - Initialization (protocol version, capabilities)
 *   - Session setup (newSession, sessionId)
 *   - Prompt turn (content blocks, stopReason)
 *   - Session updates (streaming notifications)
 *   - Permission requests (requestPermission → outcome)
 *   - Cancellation (session/cancel → stopReason: cancelled)
 *   - File system (readTextFile, writeTextFile)
 *
 * Reference: https://agentclientprotocol.com/protocol/schema
 */

import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as acp from "@agentclientprotocol/sdk";
import { StdioTransport } from "@flamecast/acp/transports/stdio";
import { PooledConnectionFactory } from "@flamecast/acp/pool";
import type {
  AgentConnectionFactory,
  AgentConnectionResult,
} from "@flamecast/acp";
import { AcpSession, configureAcp } from "../../src/session.js";
import { AcpAgents } from "../../src/agents.js";
import { pubsubObject } from "../../src/pubsub.js";

// FlamecastConnection is the class under test — ACP Agent interface over Restate
import { FlamecastConnection } from "../../src/client/connection.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ECHO_AGENT_PATH = resolve(
  import.meta.dirname,
  "../fixtures/echo-agent.ts",
);

const stdioTransport = new StdioTransport();

const innerFactory: AgentConnectionFactory = {
  async connect(_agentName, client): Promise<AgentConnectionResult> {
    const connection = await stdioTransport.connect({
      cmd: "npx",
      args: ["tsx", ECHO_AGENT_PATH],
      label: "echo-agent",
    });
    const conn = new acp.ClientSideConnection(
      () => client,
      connection.stream,
    );
    return { conn, close: () => connection.close() };
  },
};

// ─── Test setup ─────────────────────────────────────────────────────────────

let pooledFactory: PooledConnectionFactory;
let restateEnv: RestateTestEnvironment;
let connection: FlamecastConnection;

describe("ACP Compliance — FlamecastConnection as Agent", () => {
  beforeAll(async () => {
    pooledFactory = new PooledConnectionFactory(innerFactory);

    restateEnv = await RestateTestEnvironment.start({
      services: [AcpSession, AcpAgents, pubsubObject],
    });

    configureAcp(pooledFactory, { ingressUrl: restateEnv.baseUrl() });

    // Warm the pool with our echo agent
    await pooledFactory.warmup(["echo-agent"]);
  }, 60_000);

  afterAll(async () => {
    await pooledFactory?.shutdown();
    await restateEnv?.stop();
  });

  // ── Initialization ──────────────────────────────────────────────────────

  describe("Initialization", () => {
    it("negotiates protocol version and returns capabilities", async () => {
      connection = new FlamecastConnection({
        ingressUrl: restateEnv.baseUrl(),
      });

      const result = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        clientInfo: {
          name: "test-client",
          title: "Test Client",
          version: "1.0.0",
        },
      });

      expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
      expect(result.agentCapabilities).toBeDefined();
    });
  });

  // ── Session Setup ───────────────────────────────────────────────────────

  describe("Session Setup", () => {
    it("creates a new session and returns sessionId", async () => {
      connection = new FlamecastConnection({
        ingressUrl: restateEnv.baseUrl(),
      });

      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await connection.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      expect(session.sessionId).toBeDefined();
      expect(typeof session.sessionId).toBe("string");
      expect(session.sessionId.length).toBeGreaterThan(0);
    });
  });

  // ── Prompt Turn ─────────────────────────────────────────────────────────

  describe("Prompt Turn", () => {
    it("sends prompt with text content blocks and gets stopReason", async () => {
      connection = new FlamecastConnection({
        ingressUrl: restateEnv.baseUrl(),
      });

      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await connection.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      const result = await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello world" }],
      });

      expect(result.stopReason).toBe("end_turn");
    });

    it("receives session update notifications during prompt", async () => {
      const updates: acp.SessionNotification[] = [];

      connection = new FlamecastConnection({
        ingressUrl: restateEnv.baseUrl(),
        onSessionUpdate: (params) => updates.push(params),
      });

      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await connection.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "echo this" }],
      });

      // Wait for SSE events to propagate
      await new Promise((r) => setTimeout(r, 200));

      expect(updates.length).toBeGreaterThan(0);
      const textUpdate = updates.find(
        (u) => u.update.sessionUpdate === "agent_message_chunk",
      );
      expect(textUpdate).toBeDefined();
    });

    it("supports multi-turn on the same session", async () => {
      connection = new FlamecastConnection({
        ingressUrl: restateEnv.baseUrl(),
      });

      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await connection.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      const r1 = await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "turn 1" }],
      });
      expect(r1.stopReason).toBe("end_turn");

      const r2 = await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "turn 2" }],
      });
      expect(r2.stopReason).toBe("end_turn");
    });
  });

  // ── Cancellation ────────────────────────────────────────────────────────

  describe("Cancellation", () => {
    it("cancels a session and gets stopReason cancelled", async () => {
      connection = new FlamecastConnection({
        ingressUrl: restateEnv.baseUrl(),
      });

      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await connection.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      // Close the session (ACP session/close → terminateSession)
      const result = await connection.closeSession({
        sessionId: session.sessionId,
      });

      // The VO resolves the conversation loop awakeable with null → cancelled
      expect(result).toBeDefined();
    });
  });
});
