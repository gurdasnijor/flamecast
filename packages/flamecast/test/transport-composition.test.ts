/**
 * Transport composition tests.
 *
 * Validates that transports produce working ACP connections.
 *
 * Matrix:
 *   stdio:  execa + ndJsonStream → echo-agent fixture
 *   ws:     serveWs + connectWs (in-process, both ends)
 *   bridge: serveWs (agent) + connectWs (client), bridged to stdio
 *   reuse:  same process, two sequential ClientSideConnections (the session-host scenario)
 */

import { describe, it, expect, afterEach } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { connectWs, serveWs, acceptWs } from "../src/transports/websocket.js";
import { execa, type ResultPromise } from "execa";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";

// ─── Helpers ──────────────────────────────────────────────────────────────

const ECHO_AGENT_PATH = resolve(
  import.meta.dirname,
  "fixtures/echo-agent.ts",
);

/** Spawn an echo-agent and return an acp.Stream for it. */
function spawnEchoAgent(): { stream: acp.Stream; proc: ResultPromise } {
  const proc = execa("npx", ["tsx", ECHO_AGENT_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cleanup: true,
  });
  proc.catch(() => {});

  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout! as import("node:stream").Readable) as ReadableStream<Uint8Array>,
  );

  return { stream, proc };
}

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

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups) await Promise.resolve(fn()).catch(() => {});
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

  describe("bridge: WS → stdio", () => {
    it("proxies ACP through WS bridge to stdio agent", async () => {
      const { stream: agentStream, proc } = spawnEchoAgent();
      cleanups.push(() => { proc.kill(); });

      const server = await acceptWs({ port: 0 }, (clientStream) => {
        clientStream.readable.pipeTo(agentStream.writable).catch(() => {});
        agentStream.readable.pipeTo(clientStream.writable).catch(() => {});
      });
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
        prompt: [{ type: "text", text: "bridge-test" }],
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
      expect(init.agentInfo?.name).toBe("echo-agent");
      expect(result.stopReason).toBe("end_turn");
      expect(updates.length).toBeGreaterThan(0);
    });
  });

  describe("stdio", () => {
    it("full ACP handshake + prompt over stdio", async () => {
      const { stream, proc } = spawnEchoAgent();
      cleanups.push(() => { proc.kill(); });

      const updates: acp.SessionNotification[] = [];
      const agent = new acp.ClientSideConnection(makeClientFactory(updates), stream);

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

    it("same connection serves multiple prompts (pool reuse)", async () => {
      const { stream, proc } = spawnEchoAgent();
      cleanups.push(() => { proc.kill(); });

      const agent = new acp.ClientSideConnection(makeClientFactory(), stream);

      await agent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

      // Multiple prompts on the same connection — the pool scenario
      const r1 = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "turn-1" }],
      });
      const r2 = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "turn-2" }],
      });
      const r3 = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "turn-3" }],
      });

      expect(r1.stopReason).toBe("end_turn");
      expect(r2.stopReason).toBe("end_turn");
      expect(r3.stopReason).toBe("end_turn");
    });
  });
});
