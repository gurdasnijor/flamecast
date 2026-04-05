/**
 * E2E integration test: Echo Agent ↔ AcpConnection VO ↔ Durable Stream
 *
 * Tests the full durable transport: createDurableStream → AcpConnection VO → agent subprocess.
 * Uses the standard ACP SDK ClientSideConnection — same as any ACP transport.
 */

import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as clients from "@restatedev/restate-sdk-clients";
import * as acp from "@agentclientprotocol/sdk";
import { AcpConnection, pubsubObject, createDurableStream } from "../../src/index.js";
import type { CreateInput, GetMessagesAfterOutput } from "../../src/connection.js";

const ECHO_AGENT_PATH = resolve(import.meta.dirname, "../fixtures/echo-agent.ts");

const echoSpawnConfig = {
  type: "npx" as const,
  cmd: "npx",
  args: ["tsx", ECHO_AGENT_PATH],
};

let restateEnv: RestateTestEnvironment;
let ingress: clients.Ingress;
let ingressUrl: string;

describe("AcpConnection E2E with Echo Agent", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpConnection, pubsubObject],
    });
    ingressUrl = restateEnv.baseUrl();
    process.env.RESTATE_INGRESS_URL = ingressUrl;
    ingress = clients.connect({ url: ingressUrl });
  }, 60_000);

  afterAll(async () => {
    await restateEnv?.stop();
  });

  /** Create a durable connection and return a standard ClientSideConnection */
  async function createConnection(cwd = "/tmp") {
    const connectionId = crypto.randomUUID();
    const vo = ingress.objectClient(AcpConnection, connectionId);

    await vo.create({
      agentName: "echo",
      spawnConfig: echoSpawnConfig,
      cwd,
      mcpServers: [],
    } satisfies CreateInput as never);

    const stream = createDurableStream({ connectionId, ingressUrl });

    const events: acp.SessionNotification[] = [];
    const conn = new acp.ClientSideConnection(
      () => ({
        async sessionUpdate(p: acp.SessionNotification) {
          events.push(p);
        },
        async requestPermission(p: acp.RequestPermissionRequest) {
          return { outcome: { outcome: "selected" as const, optionId: p.options[0]?.optionId ?? "" } };
        },
      }),
      stream,
    );

    return { connectionId, conn, events };
  }

  it("creates a connection and initializes", async () => {
    const { conn } = await createConnection();
    const result = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(result.protocolVersion).toBeDefined();
  }, 30_000);

  it("creates a session and sends a prompt", async () => {
    const { conn } = await createConnection();

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
    expect(typeof sessionId).toBe("string");

    const result = await conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hello world" }],
    });
    expect(result.stopReason).toBe("end_turn");
  }, 30_000);

  it("multi-turn conversation", async () => {
    const { conn } = await createConnection();

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    const r1 = await conn.prompt({ sessionId, prompt: [{ type: "text", text: "turn 1" }] });
    expect(r1.stopReason).toBe("end_turn");

    const r2 = await conn.prompt({ sessionId, prompt: [{ type: "text", text: "turn 2" }] });
    expect(r2.stopReason).toBe("end_turn");
  }, 30_000);

  it("receives sessionUpdate notifications", async () => {
    const { conn, events } = await createConnection();

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
    await conn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

    // The echo agent should send at least one agent_message_chunk
    const chunks = events.filter((e) => e.update.sessionUpdate === "agent_message_chunk");
    expect(chunks.length).toBeGreaterThan(0);
  }, 30_000);

  it("messages appear in the VO log", async () => {
    const { connectionId, conn } = await createConnection();

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
    await conn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

    // Wait a moment for the bridge to flush
    await new Promise((r) => setTimeout(r, 1000));

    const vo = ingress.objectClient(AcpConnection, connectionId);
    const { messages } = await vo.getMessagesAfter({ afterSeq: -1 } as never) as GetMessagesAfterOutput;
    expect(messages.length).toBeGreaterThan(0);
  }, 30_000);

  it("getStatus returns connection info", async () => {
    const { connectionId } = await createConnection();
    const vo = ingress.objectClient(AcpConnection, connectionId);
    const status = await vo.getStatus() as any;
    expect(status.connectionId).toBe(connectionId);
    expect(status.agentName).toBe("echo");
    expect(status.closed).toBe(false);
  }, 30_000);
});
