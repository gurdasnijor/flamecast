/**
 * Integration test: ZedAgentSession VO
 *
 * Mock Zed ACP agent as a stdio process (a small Node script that speaks
 * the ACP protocol over JSON-RPC). Tests: startSession, runAgent, getStatus.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as clients from "@restatedev/restate-sdk-clients";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ZedAgentSession } from "../src/zed-agent-session.js";
import { pubsubObject } from "../src/session-object.js";
import type { SessionMeta } from "../src/adapter.js";

// ── Mock ACP agent (speaks official ACP protocol over ndjson stdio) ────────

let mockAgentDir: string;
let mockAgentScript: string;

function createMockAgent(): void {
  mockAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-zed-"));
  mockAgentScript = path.join(mockAgentDir, "agent.mjs");
  fs.writeFileSync(
    mockAgentScript,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "mock-agent", version: "1.0.0" },
        agentCapabilities: {},
      },
    }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { sessionId: "mock-session-1" },
    }) + "\\n");
  } else if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId ?? "mock-session-1";
    // Send session/update notification with the agent's text output
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "42" },
        },
      },
    }) + "\\n");
    // Then respond with the prompt result
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { stopReason: "end_turn" },
    }) + "\\n");
  } else if (msg.method === "session/cancel") {
    // notification — no response
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id, result: {},
    }) + "\\n");
  }
});
`,
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ZedAgentSession VO", () => {
  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;

  beforeAll(async () => {
    createMockAgent();
    env = await RestateTestEnvironment.start({
      services: [ZedAgentSession, pubsubObject],
    });
    ingress = clients.connect({ url: env.baseUrl() });
  }, 30_000);

  afterAll(async () => {
    await env?.stop();
    if (mockAgentDir) {
      fs.rmSync(mockAgentDir, { recursive: true, force: true });
    }
  });

  it("startSession + runAgent returns completed result", async () => {
    const key = "zed-start-run";
    const client = ingress.objectClient(ZedAgentSession, key);

    // Start session — pass node as the binary, script as arg
    const session = await client.startSession({
      agent: "node",
      args: [mockAgentScript],
    });
    expect(session.protocol).toBe("zed");
    expect(session.agent.name).toBe("mock-agent");

    // Run a prompt — mock sends "42" via session/update then completes
    const result = await client.runAgent({ text: "What is 6*7?" });
    expect(result.status).toBe("completed");
    expect(result.output).toBeDefined();
    expect(result.output![0].parts[0].content).toBe("42");

    // Verify VO state
    const state = env.stateOf(ZedAgentSession, key);
    const lastRun = await state.get("lastRun");
    expect(lastRun).toBeDefined();
  }, 20_000);

  it("getStatus returns session metadata", async () => {
    const key = "zed-status";
    const client = ingress.objectClient(ZedAgentSession, key);

    await client.startSession({
      agent: "node",
      args: [mockAgentScript],
    });

    const meta = await client.getStatus();
    expect(meta).toBeDefined();
    expect(meta!.sessionId).toBe(key);
    expect(meta!.protocol).toBe("zed");
    expect(meta!.agent.name).toBe("mock-agent");
    expect(meta!.status).toBe("active");
  }, 20_000);
});
