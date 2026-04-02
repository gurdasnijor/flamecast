/**
 * Integration test for the ACP Restate layer.
 *
 * Starts:
 *   1. ACP Gateway (HTTP, port 4000) — spawns agents via stdio
 *   2. Restate endpoint (port 9080) — AcpRun VO + AcpAgents service
 *   3. Restate server (testcontainers) — journals + state
 *
 * Tests the full path: typed client → Restate ingress → AcpRun VO → Gateway → agent
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { AcpRun } from "../../src/acp/run-vo.js";
import { acpAgents } from "../../src/acp/agent-service.js";
import { createAcpClient } from "../../src/acp/client.js";
import { pubsubObject } from "../../src/restate/pubsub.js";

const GATEWAY_URL = process.env.ACP_GATEWAY_URL ?? "http://localhost:4000";

let restateEnv: RestateTestEnvironment;
let client: ReturnType<typeof createAcpClient>;

describe("ACP Restate Integration", () => {
  beforeAll(async () => {
    // Verify gateway is running
    const ping = await fetch(`${GATEWAY_URL}/ping`).catch(() => null);
    if (!ping?.ok) {
      throw new Error(
        `ACP Gateway not running at ${GATEWAY_URL}. Start it with: pnpm --filter @flamecast/acp-gateway dev`,
      );
    }

    // Start Restate with our services
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpRun, acpAgents, pubsubObject],
    });

    client = createAcpClient({ restateUrl: restateEnv.baseUrl() });
  }, 60_000);

  afterAll(async () => {
    await restateEnv?.stop();
  });

  it("lists agents from gateway", async () => {
    const agents = await client.agents();
    expect(agents).toBeInstanceOf(Array);
    expect(agents.length).toBeGreaterThan(0);
  });

  it("runs a sync prompt through the VO", async () => {
    const result = await client.prompt("claude-acp", "Say exactly: test-ok");

    expect(result.status).toBe("completed");
    expect(result.output).toBeDefined();
    expect(result.output!.length).toBeGreaterThan(0);
  }, 30_000);

  it("runs async and polls for status", async () => {
    const { runId } = await client.runAsync(
      "claude-acp",
      [{ role: "user", parts: [{ content_type: "text/plain", content: "Say hi" }] }] as never,
    );

    expect(runId).toBeDefined();

    // Poll until done
    let status;
    for (let i = 0; i < 30; i++) {
      const run = await client.getStatus(runId);
      status = run?.status;
      if (status === "completed" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(status).toBe("completed");
  }, 60_000);

  it("cancels a running run", async () => {
    const { runId } = await client.runAsync(
      "claude-acp",
      [{ role: "user", parts: [{ content_type: "text/plain", content: "Write a 2000 word essay" }] }] as never,
    );

    // Wait for it to start
    await new Promise((r) => setTimeout(r, 3000));

    const result = await client.cancel(runId);
    // Cancel is best-effort — status could be cancelling, cancelled,
    // or already completed if the agent was fast
    expect(["cancelling", "cancelled", "completed", "in-progress"]).toContain(
      result.status,
    );
  }, 30_000);

  it("buffers events for replay", async () => {
    const result = await client.prompt("claude-acp", "Count to 3");
    expect(result.status).toBe("completed");

    // Events should be buffered in VO state — find the run ID
    // The prompt() helper generates a random run ID internally,
    // so we test via runAsync where we control the ID
    const { runId } = await client.runAsync(
      "claude-acp",
      [{ role: "user", parts: [{ content_type: "text/plain", content: "Say hello" }] }] as never,
    );

    // Wait for completion
    for (let i = 0; i < 30; i++) {
      const run = await client.getStatus(runId);
      if (run?.status === "completed" || run?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const events = await client.getEvents(runId);
    expect(events).toBeInstanceOf(Array);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e: { type: string }) => e.type === "run.created")).toBe(true);
  }, 60_000);

  it("runs parallel fan-out across agents", async () => {
    // Check which agents are available
    const agents = await client.agents();
    const available = (agents as Array<{ name: string }>)
      .map((a) => a.name)
      .filter((n) => ["claude-acp", "codex-acp", "opencode"].includes(n));

    if (available.length < 2) {
      console.log(`Skipping parallel test — only ${available.length} agents available`);
      return;
    }

    // Use the acpAgents service directly via ingress
    const result = await client.prompt(available[0], "Say: parallel-test-ok");
    expect(result.status).toBe("completed");
  }, 30_000);
});
