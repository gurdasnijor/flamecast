/**
 * Integration test: IbmAgentSession VO
 *
 * Mock ACP agent as HTTP server that speaks the acp-sdk wire format.
 * Tests: startSession, runAgent (async + awakeable), getStatus.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as clients from "@restatedev/restate-sdk-clients";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { IbmAgentSession } from "../src/ibm-agent-session.js";
import { pubsubObject } from "../src/session-object.js";
import type { SessionMeta } from "../src/adapter.js";

// ── Mock IBM ACP agent server (acp-sdk compatible) ────────────────────────

interface MockAgent {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

async function startMockAgent(): Promise<MockAgent> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    const url = req.url ?? "";

    // GET /agents/echo — agent discovery (AgentsReadResponse / AgentManifest)
    if (req.method === "GET" && url.includes("/agents/echo")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "echo",
          description: "test echo agent",
          input_content_types: ["text/plain"],
          output_content_types: ["text/plain"],
          metadata: {},
        }),
      );
      return;
    }

    // POST /runs — create run (RunCreateResponse format)
    if (req.method === "POST" && url === "/runs") {
      const runId = crypto.randomUUID();
      const mode = body.mode ?? "async";
      const now = new Date().toISOString();

      if (mode === "sync") {
        // Sync mode — return completed run immediately
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            run_id: runId,
            agent_name: body.agent_name ?? "echo",
            status: "completed",
            created_at: now,
            output: [
              {
                role: "assistant",
                parts: [{ content_type: "text/plain", content: "Echo: hello" }],
                created_at: now,
              },
            ],
          }),
        );
      } else {
        // Async mode — return created run
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            run_id: runId,
            agent_name: body.agent_name ?? "echo",
            status: "created",
            created_at: now,
            output: [],
          }),
        );
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://localhost:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("IbmAgentSession VO", () => {
  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;
  let mock: MockAgent;

  beforeAll(async () => {
    mock = await startMockAgent();
    env = await RestateTestEnvironment.start({
      services: [IbmAgentSession, pubsubObject],
    });
    ingress = clients.connect({ url: env.baseUrl() });
  }, 30_000);

  afterAll(async () => {
    await env?.stop();
    await mock?.close();
  });

  it("startSession creates session and persists meta", async () => {
    const key = "ibm-test-1";
    const client = ingress.objectClient(IbmAgentSession, key);

    const session = await client.startSession({
      agent: `${mock.url}/agents/echo`,
    });

    expect(session.protocol).toBe("ibm");
    expect(session.agent.name).toBe("echo");

    const state = env.stateOf(IbmAgentSession, key);
    const meta = await state.get<SessionMeta>("meta");
    expect(meta).toBeDefined();
    expect(meta!.status).toBe("active");
    expect(meta!.protocol).toBe("ibm");
  });

  it("runAgent creates run and suspends on awakeable", async () => {
    const key = "ibm-test-run";
    const client = ingress.objectClient(IbmAgentSession, key);

    await client.startSession({ agent: `${mock.url}/agents/echo` });

    // Fire runAgent — it will create the run then suspend on awakeable
    const runPromise = client.runAgent({ text: "hello" });

    // Wait for the awakeable to be stored
    await new Promise((r) => setTimeout(r, 2000));

    const state = env.stateOf(IbmAgentSession, key);
    const pendingRun = await state.get<{ awakeableId: string; runId: string }>(
      "pending_run",
    );
    expect(pendingRun).toBeDefined();
    expect(pendingRun!.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(pendingRun!.awakeableId).toBeDefined();

    // Resolve the awakeable (simulating watchAgentRun)
    await ingress.resolveAwakeable(pendingRun!.awakeableId, {
      status: "completed",
      output: [
        {
          role: "assistant",
          parts: [{ contentType: "text/plain", content: "Echo: hello" }],
        },
      ],
    });

    const result = await runPromise;
    expect(result.status).toBe("completed");
    expect(result.output).toBeDefined();
    expect(result.output![0].parts[0].content).toBe("Echo: hello");
  }, 20_000);

  it("getStatus returns meta via shared handler", async () => {
    const key = "ibm-test-status";
    const client = ingress.objectClient(IbmAgentSession, key);

    await client.startSession({ agent: `${mock.url}/agents/echo` });
    const meta = await client.getStatus();
    expect(meta).toBeDefined();
    expect(meta!.sessionId).toBe(key);
  });
});
