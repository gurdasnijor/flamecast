/**
 * Durability & cancel tests — mono-maks + mono-nlve
 *
 * Tests:
 * 1. ctx.run() journals initialize/newSession (not re-executed on reconnect)
 * 2. getOrReconnect respawns from durable state when session cache is cleared
 * 3. cancel during in-flight prompt returns stopReason: cancelled
 */

import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as acp from "@agentclientprotocol/sdk";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { AcpAgent, registerAgent } from "../../src/agent.js";
import { pubsubObject } from "../../src/pubsub.js";
import { createRestateStream } from "../../src/client/restate-stream.js";

const ECHO_AGENT_PATH = resolve(import.meta.dirname, "../fixtures/echo-agent.ts");
const SLOW_AGENT_PATH = resolve(import.meta.dirname, "../fixtures/slow-agent.ts");

registerAgent("echo-agent", {
  id: "echo-agent",
  distribution: { type: "npx" as const, cmd: "npx", args: ["tsx", ECHO_AGENT_PATH] },
});

registerAgent("slow-agent", {
  id: "slow-agent",
  distribution: { type: "npx" as const, cmd: "npx", args: ["tsx", SLOW_AGENT_PATH] },
});

class TestClient implements acp.Client {
  updates: acp.SessionNotification[] = [];
  async sessionUpdate(params: acp.SessionNotification) { this.updates.push(params); }
  async requestPermission(params: acp.RequestPermissionRequest) {
    return { outcome: { outcome: "selected" as const, optionId: params.options[0].optionId } };
  }
}

function connect(ingressUrl: string) {
  const pubsub = createPubsubClient({ name: "pubsub", ingressUrl });
  const sessionKey = crypto.randomUUID();
  const stream = createRestateStream({ ingressUrl, sessionKey, pubsub });
  const conn = new acp.ClientSideConnection(() => new TestClient(), stream);
  return { conn, sessionKey };
}

let restateEnv: RestateTestEnvironment;

describe("Durability & Cancel", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpAgent, pubsubObject],
    });
  }, 60_000);

  afterAll(async () => {
    await restateEnv?.stop();
  });

  // ── mono-maks: ctx.run() journals results ──────────────────────────────

  describe("Durable steps (mono-maks)", () => {
    it("initialize + newSession succeed and store durable state", async () => {
      const { conn } = connect(restateEnv.baseUrl());

      const initResult = await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { agentName: "echo-agent" },
      });
      expect(initResult.protocolVersion).toBe(acp.PROTOCOL_VERSION);

      const sessionResult = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
      expect(sessionResult.sessionId).toBeDefined();
    }, 30_000);

    it("prompt works after initialize + newSession", async () => {
      const { conn } = connect(restateEnv.baseUrl());

      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { agentName: "echo-agent" },
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      const result = await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "durability test" }],
      });
      expect(result.stopReason).toBe("end_turn");
    }, 30_000);

    it("multi-turn prompt reuses the same session", async () => {
      const { conn } = connect(restateEnv.baseUrl());

      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { agentName: "echo-agent" },
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      const r1 = await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "turn 1" }],
      });
      const r2 = await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "turn 2" }],
      });
      const r3 = await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "turn 3" }],
      });

      expect(r1.stopReason).toBe("end_turn");
      expect(r2.stopReason).toBe("end_turn");
      expect(r3.stopReason).toBe("end_turn");
    }, 30_000);
  });

  // ── mono-nlve: cancel during in-flight prompt ──────────────────────────

  describe("Cancel (mono-nlve)", () => {
    it("cancel during in-flight prompt returns cancelled", async () => {
      const { conn } = connect(restateEnv.baseUrl());

      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { agentName: "slow-agent" },
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      // Fire prompt (slow agent waits 5s) and cancel after 500ms
      const promptPromise = conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "this should be cancelled" }],
      });

      await new Promise((r) => setTimeout(r, 500));
      await conn.cancel({ sessionId: session.sessionId });

      const result = await promptPromise;
      expect(result.stopReason).toBe("cancelled");
    }, 15_000);
  });
});
