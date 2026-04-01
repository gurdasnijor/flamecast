/**
 * Integration test: ZedAgentSession VO
 *
 * Mock Zed ACP agent as a stdio process (a small Node script that speaks
 * JSON-RPC). Test create session → runAgent → verify result in VO state.
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

// ── Mock Zed ACP agent (Node script that speaks JSON-RPC over stdio) ────────

let mockAgentPath: string;

function createMockAgent(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-zed-"));
  const script = path.join(dir, "agent.mjs");
  fs.writeFileSync(
    script,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { serverInfo: { name: "mock-agent" }, capabilities: {} },
    }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id, result: { id: "mock-session-1" },
    }) + "\\n");
  } else if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: {
        status: "completed",
        output: [{ role: "assistant", parts: [{ contentType: "text/plain", content: "42" }] }],
      },
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
  return script;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ZedAgentSession VO", () => {
  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;

  beforeAll(async () => {
    mockAgentPath = createMockAgent();
    env = await RestateTestEnvironment.start({
      services: [ZedAgentSession, pubsubObject],
    });
    ingress = clients.connect({ url: env.baseUrl() });
  }, 30_000);

  afterAll(async () => {
    await env?.stop();
    if (mockAgentPath) {
      fs.rmSync(path.dirname(mockAgentPath), { recursive: true, force: true });
    }
  });

  it("startSession + runAgent returns completed result", async () => {
    // Shell wrapper that ignores --acp and runs the mock JSON-RPC script
    const dir = path.dirname(mockAgentPath);
    const wrapper = path.join(dir, "mock-agent.sh");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec node "${mockAgentPath}"\n`);
    fs.chmodSync(wrapper, 0o755);

    const key = "zed-test-run";
    const client = ingress.objectClient(ZedAgentSession, key);

    const session = await client.startSession({ agent: wrapper });
    expect(session.protocol).toBe("zed");
    expect(session.agent.name).toBe("mock-agent");

    const result = await client.runAgent({ text: "What is 6*7?" });
    expect(result.status).toBe("completed");
    expect(result.output).toBeDefined();
    expect(result.output![0].parts[0].content).toBe("42");

    // Verify state
    const state = env.stateOf(ZedAgentSession, key);
    const meta = await state.get<SessionMeta>("meta");
    expect(meta!.status).toBe("active");
    expect(meta!.protocol).toBe("zed");

    const lastRun = await state.get("lastRun");
    expect(lastRun).toBeDefined();
  }, 20_000);

  it("getStatus returns meta via shared handler", async () => {
    const key = "zed-test-run"; // reuse from above
    const client = ingress.objectClient(ZedAgentSession, key);
    const meta = await client.getStatus();
    expect(meta).toBeDefined();
    expect(meta!.sessionId).toBe(key);
  });
});
