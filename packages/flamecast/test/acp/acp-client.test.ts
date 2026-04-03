/**
 * Integration test for the ACP Restate layer.
 *
 * Uses FlamecastClient against a Restate test environment.
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
    expect(status!.sessionId).toBe(sessionId);
    expect(status!.cwd).toBeDefined();
  }, 30_000);

  it("sends a prompt", async () => {
    const { sessionId } = await client.startSession("claude-acp");

    // sendPrompt returns immediately (async mode)
    const response = await client.sendPrompt(sessionId, "Say hello");
    expect(response.stopReason).toBe("end_turn");

    await client.terminate(sessionId);
  }, 60_000);

  it("terminates a session", async () => {
    const { sessionId } = await client.startSession("claude-acp");

    const result = await client.terminate(sessionId);
    expect(result.stopReason).toBe("cancelled");
  }, 30_000);
});
