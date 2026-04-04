/**
 * E2E integration test: Echo Agent ↔ AgentConnection + AgentSession VOs
 */

import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as clients from "@restatedev/restate-sdk-clients";
import * as acp from "@agentclientprotocol/sdk";
import { AgentConnection } from "../../src/agent-connection.js";
import { AgentSession } from "../../src/agent-session.js";

const ECHO_AGENT_PATH = resolve(import.meta.dirname, "../fixtures/echo-agent.ts");

const echoSpawnConfig = {
  type: "npx" as const,
  cmd: "npx",
  args: ["tsx", ECHO_AGENT_PATH],
};

let restateEnv: RestateTestEnvironment;
let ingress: clients.Ingress;

describe("AgentSession E2E with Echo Agent", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AgentConnection, AgentSession],
    });
    ingress = clients.connect({ url: restateEnv.baseUrl() });
  }, 60_000);

  afterAll(async () => {
    await restateEnv?.stop();
  });

  async function createSession() {
    const clientId = crypto.randomUUID();
    const conn = ingress.objectClient(AgentConnection, clientId);
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    } as never);
    const { sessionId } = await conn.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { spawnConfig: echoSpawnConfig },
    } as never) as { sessionId: string };
    return { clientId, sessionId };
  }

  it("creates a session", async () => {
    const { sessionId } = await createSession();
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe("string");
  }, 30_000);

  it("sends a prompt and gets stopReason back", async () => {
    const { sessionId } = await createSession();
    const result = await ingress.objectClient(AgentSession, sessionId).prompt({
      sessionId,
      prompt: [{ type: "text", text: "hello world" }],
    } as never) as acp.PromptResponse;
    expect(result.stopReason).toBe("end_turn");
  }, 30_000);

  it("multi-turn on the same session", async () => {
    const { sessionId } = await createSession();
    const session = ingress.objectClient(AgentSession, sessionId);

    const r1 = await session.prompt({
      sessionId,
      prompt: [{ type: "text", text: "turn 1" }],
    } as never) as acp.PromptResponse;
    expect(r1.stopReason).toBe("end_turn");

    const r2 = await session.prompt({
      sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    } as never) as acp.PromptResponse;
    expect(r2.stopReason).toBe("end_turn");
  }, 30_000);

  it("accumulates updates across prompts", async () => {
    const { sessionId } = await createSession();
    const session = ingress.objectClient(AgentSession, sessionId);

    await session.prompt({
      sessionId,
      prompt: [{ type: "text", text: "first" }],
    } as never);
    await session.prompt({
      sessionId,
      prompt: [{ type: "text", text: "second" }],
    } as never);

    const updates = await session.getUpdates() as acp.SessionNotification[];
    const chunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("listSessions returns created sessions", async () => {
    const clientId = crypto.randomUUID();
    const conn = ingress.objectClient(AgentConnection, clientId);
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    } as never);
    await conn.newSession({ cwd: "/a", mcpServers: [], _meta: { spawnConfig: echoSpawnConfig } } as never);
    await conn.newSession({ cwd: "/b", mcpServers: [], _meta: { spawnConfig: echoSpawnConfig } } as never);

    const { sessions } = await conn.listSessions({} as never) as { sessions: any[] };
    expect(sessions).toHaveLength(2);
  }, 60_000);
});
