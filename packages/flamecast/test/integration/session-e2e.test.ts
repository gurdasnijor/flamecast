/**
 * E2E integration test: Echo Agent ↔ AcpAgent VO ↔ FlamecastClient
 */

import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { AcpAgent } from "../../src/agent.js";
import { pubsubObject } from "../../src/pubsub.js";
import { registerAgent } from "../../src/registry.js";
import { FlamecastClient } from "../../src/client/index.js";

const ECHO_AGENT_PATH = resolve(
  import.meta.dirname,
  "../fixtures/echo-agent.ts",
);

registerAgent({
  id: "echo-agent",
  manifest: { name: "echo-agent", description: "Echo", version: "1.0" },
  distribution: { type: "npx" as const, cmd: "npx", args: ["tsx", ECHO_AGENT_PATH] },
});

let restateEnv: RestateTestEnvironment;
let client: FlamecastClient;

describe("AcpAgent E2E with Echo Agent", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpAgent, pubsubObject],
    });

    client = new FlamecastClient({
      ingressUrl: restateEnv.baseUrl(),
    });
  }, 60_000);

  afterAll(async () => {
    client.dispose();
    await restateEnv?.stop();
  });

  it("creates a session (blocking)", async () => {
    const session = await client.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { agentName: "echo-agent" },
    });
    expect(session.sessionId).toBeDefined();

    const status = await client.getStatus(session.sessionId);
    expect(status).toBeDefined();
  }, 30_000);

  it("sends a prompt and gets stopReason back (blocking)", async () => {
    const session = await client.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { agentName: "echo-agent" },
    });
    const result = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello world" }],
    });
    expect(result.stopReason).toBe("end_turn");
  }, 30_000);

  it("multi-turn on the same session", async () => {
    const session = await client.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { agentName: "echo-agent" },
    });

    const r1 = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 1" }],
    });
    expect(r1.stopReason).toBe("end_turn");

    const r2 = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    });
    expect(r2.stopReason).toBe("end_turn");
  }, 30_000);

  it("closes a session", async () => {
    const session = await client.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { agentName: "echo-agent" },
    });
    const result = await client.closeSession({
      sessionId: session.sessionId,
    });
    expect(result.stopReason).toBe("cancelled");
  }, 30_000);
});
