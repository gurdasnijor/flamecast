/**
 * Integration test for the ACP Restate layer.
 *
 * Starts:
 *   1. Restate endpoint (port 9080) — AcpSession VO
 *   2. Restate server (testcontainers) — journals + state
 *
 * Tests the full path: typed client → Restate ingress → AcpSession VO → AcpClient → agent
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { AcpSession } from "../../src/acp/session.js";
import { createAcpClient } from "../../src/acp/client.js";
import { pubsubObject } from "../../src/restate/pubsub.js";

let restateEnv: RestateTestEnvironment;
let client: ReturnType<typeof createAcpClient>;

describe("ACP Restate Integration", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpSession, pubsubObject],
    });

    client = createAcpClient({
      ingressUrl: restateEnv.baseUrl(),
      adminUrl: restateEnv.baseUrl().replace(":18080", ":19070"),
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

    // Poll until the session returns to active (turn completed)
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
