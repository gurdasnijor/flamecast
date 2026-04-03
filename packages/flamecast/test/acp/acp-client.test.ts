/**
 * Integration test for the ACP Restate layer.
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

  it("creates a session and gets status", async () => {
    const { sessionId } = await client.newSession("claude-acp");
    expect(sessionId).toBeDefined();

    const status = await client.getStatus(sessionId);
    expect(status).toBeDefined();
    expect(status!.sessionId).toBe(sessionId);
  }, 30_000);

  it("closes a session", async () => {
    const { sessionId } = await client.newSession("claude-acp");
    const result = await client.close(sessionId);
    expect(result.stopReason).toBe("cancelled");
  }, 30_000);
});
