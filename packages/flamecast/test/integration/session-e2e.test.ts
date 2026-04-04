/**
 * E2E integration test: Echo Agent ↔ AcpAgent VO ↔ createRestateStream
 */

import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as acp from "@agentclientprotocol/sdk";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { AcpAgent, registerAgent } from "../../src/agent.js";
import { pubsubObject } from "../../src/pubsub.js";
import { createRestateStream } from "../../src/client/restate-stream.js";

const ECHO_AGENT_PATH = resolve(
  import.meta.dirname,
  "../fixtures/echo-agent.ts",
);

registerAgent("echo-agent", {
  id: "echo-agent",
  distribution: { type: "npx" as const, cmd: "npx", args: ["tsx", ECHO_AGENT_PATH] },
});

class TestClient implements acp.Client {
  async sessionUpdate() {}
  async requestPermission(params: acp.RequestPermissionRequest) {
    return { outcome: { outcome: "selected" as const, optionId: params.options[0].optionId } };
  }
}

function connect(ingressUrl: string) {
  const pubsub = createPubsubClient({ name: "pubsub", ingressUrl });
  const sessionKey = crypto.randomUUID();
  const stream = createRestateStream({ ingressUrl, sessionKey, pubsub });
  const conn = new acp.ClientSideConnection(() => new TestClient(), stream);
  return { conn, sessionKey, dispose: () => {} };
}

let restateEnv: RestateTestEnvironment;

describe("AcpAgent E2E with Echo Agent", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpAgent, pubsubObject],
    });
  }, 60_000);

  afterAll(async () => {
    await restateEnv?.stop();
  });

  it("creates a session", async () => {
    const { conn } = connect(restateEnv.baseUrl());
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      _meta: { agentName: "echo-agent" },
    });
    const session = await conn.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { agentName: "echo-agent" },
    });
    expect(session.sessionId).toBeDefined();
  }, 30_000);

  it("sends a prompt and gets stopReason back", async () => {
    const { conn } = connect(restateEnv.baseUrl());
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      _meta: { agentName: "echo-agent" },
    });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
    const result = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello world" }],
    });
    expect(result.stopReason).toBe("end_turn");
  }, 30_000);

  it("multi-turn on the same session", async () => {
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
    expect(r1.stopReason).toBe("end_turn");

    const r2 = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    });
    expect(r2.stopReason).toBe("end_turn");
  }, 30_000);
});
