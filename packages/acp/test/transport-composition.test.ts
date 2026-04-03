/**
 * Transport composition tests.
 *
 * Validates that connectX + serveX produce working ACP connections
 * across all transport types.
 *
 * Matrix:
 *   stdio:  connectStdio → echo-agent fixture
 *   ws:     serveWs + connectWs (in-process, both ends)
 *   mixed:  serveWs (agent) + connectWs (client), different codecs aren't possible
 *           since the transport function picks the right serialization internally
 */

import { describe, it, expect, afterEach } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { connectStdio } from "../src/transports/stdio.js";
import { connectWs, serveWs } from "../src/transports/websocket.js";
import { resolve } from "node:path";

// ─── Echo agent factory (for serve* functions) ─────────────────────────────

function echoAgentFactory(conn: acp.AgentSideConnection): acp.Agent {
  return {
    async initialize(params) {
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "echo", title: "Echo", version: "1.0" },
      };
    },
    async newSession() {
      return { sessionId: "echo-sess-" + Math.random().toString(36).slice(2) };
    },
    async authenticate() {},
    async prompt(params) {
      const text = params.prompt
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");

      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `echo: ${text}` },
        },
      });

      return { stopReason: "end_turn" };
    },
    async cancel() {},
  };
}

// ─── Client factory ────────────────────────────────────────────────────────

function makeClientFactory(updates?: acp.SessionNotification[]) {
  return () => ({
    async sessionUpdate(params: acp.SessionNotification) {
      updates?.push(params);
    },
    async requestPermission(params: acp.RequestPermissionRequest) {
      return {
        outcome: {
          outcome: "selected" as const,
          optionId: params.options[0].optionId,
        },
      };
    },
  });
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups) await fn().catch(() => {});
  cleanups.length = 0;
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Transport Composition", () => {

  describe("WebSocket", () => {
    it("full ACP handshake + prompt over ws", async () => {
      const server = await serveWs({ port: 0 }, echoAgentFactory);
      cleanups.push(() => server.close());

      const updates: acp.SessionNotification[] = [];
      const agent = await connectWs(
        { url: `ws://localhost:${server.port}` },
        makeClientFactory(updates),
      );

      const init = await agent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
      const result = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "ws-test" }],
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
      expect(init.agentInfo?.name).toBe("echo");
      expect(session.sessionId).toMatch(/^echo-sess-/);
      expect(result.stopReason).toBe("end_turn");
      expect(updates.length).toBeGreaterThan(0);
    });

    it("two clients on same server get independent sessions", async () => {
      const server = await serveWs({ port: 0 }, echoAgentFactory);
      cleanups.push(() => server.close());

      const url = `ws://localhost:${server.port}`;
      const a1 = await connectWs({ url }, makeClientFactory());
      const a2 = await connectWs({ url }, makeClientFactory());

      await a1.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      await a2.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

      const s1 = await a1.newSession({ cwd: "/tmp", mcpServers: [] });
      const s2 = await a2.newSession({ cwd: "/tmp", mcpServers: [] });

      expect(s1.sessionId).not.toBe(s2.sessionId);

      const r1 = await a1.prompt({ sessionId: s1.sessionId, prompt: [{ type: "text", text: "c1" }] });
      const r2 = await a2.prompt({ sessionId: s2.sessionId, prompt: [{ type: "text", text: "c2" }] });

      expect(r1.stopReason).toBe("end_turn");
      expect(r2.stopReason).toBe("end_turn");
    });
  });

  describe("stdio", () => {
    const ECHO_AGENT_PATH = resolve(
      import.meta.dirname,
      "../../flamecast/test/fixtures/echo-agent.ts",
    );

    it("full ACP handshake + prompt over stdio", async () => {
      const updates: acp.SessionNotification[] = [];
      const agent = connectStdio(
        { cmd: "npx", args: ["tsx", ECHO_AGENT_PATH], label: "echo-agent" },
        makeClientFactory(updates),
      );

      const init = await agent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
      const result = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "stdio-test" }],
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
      expect(init.agentInfo?.name).toBe("echo-agent");
      expect(result.stopReason).toBe("end_turn");
      expect(updates.length).toBeGreaterThan(0);
    });
  });
});
