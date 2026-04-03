/**
 * Integration test for the ACP Restate layer.
 *
 * Uses @flamecast/client (the single client) against a Restate test environment.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { AcpSession } from "../../src/session.js";
import { pubsubObject } from "../../src/pubsub.js";
import { FlamecastClient } from "../../src/client/index.js";

let restateEnv: RestateTestEnvironment;
let client: FlamecastClient;

describe("ACP Restate Integration", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpSession, pubsubObject],
    });

    client = new FlamecastClient({
      ingressUrl: restateEnv.baseUrl(),
    });
  }, 60_000);

  afterAll(async () => {
    await restateEnv?.stop();
  });

  it("starts a session and gets status", async () => {
    const { sessionId } = await client.startSession("claude-acp");
    expect(sessionId).toBeDefined();

    const status = await client.getStatus(sessionId);
    expect(status).toBeDefined();
    expect(status!.agentName).toBe("claude-acp");
    expect(["created", "in-progress"]).toContain(status!.status);
  }, 30_000);

  it("sends a prompt and receives a response", async () => {
    const { sessionId } = await client.startSession("claude-acp");

    await client.sendPrompt(sessionId, "Say exactly: test-ok");

    let status;
    for (let i = 0; i < 30; i++) {
      status = await client.getStatus(sessionId);
      if (status?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(status?.status).toBe("completed");

    await client.terminate(sessionId);
  }, 60_000);

  it("terminates a session", async () => {
    const { sessionId } = await client.startSession("claude-acp");

    await client.terminate(sessionId);

    const status = await client.getStatus(sessionId);
    expect(status?.status).toBe("killed");
  }, 30_000);
});
