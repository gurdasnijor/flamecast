/**
 * E2E integration test: Echo Agent ↔ AcpSession VO ↔ FlamecastClient
 */

import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as acp from "@agentclientprotocol/sdk";
import { StdioTransport } from "@flamecast/acp/transports/stdio";
import { PooledConnectionFactory } from "@flamecast/acp/pool";
import type { AgentConnectionFactory, AgentConnectionResult } from "@flamecast/acp";
import { AcpSession, configureAcp } from "../../src/session.js";
import { AcpAgents } from "../../src/agents.js";
import { pubsubObject } from "../../src/pubsub.js";
import { FlamecastClient } from "../../src/client/index.js";

const ECHO_AGENT_PATH = resolve(
  import.meta.dirname,
  "../fixtures/echo-agent.ts",
);

const stdioTransport = new StdioTransport();

const innerFactory: AgentConnectionFactory = {
  async connect(_agentName, client): Promise<AgentConnectionResult> {
    const connection = await stdioTransport.connect({
      cmd: "npx",
      args: ["tsx", ECHO_AGENT_PATH],
      label: "echo-agent",
    });

    const conn = new acp.ClientSideConnection(
      () => client,
      connection.stream,
    );

    return { conn, close: () => connection.close() };
  },
};

let pooledFactory: PooledConnectionFactory;
let restateEnv: RestateTestEnvironment;
let client: FlamecastClient;

describe("AcpSession E2E with Echo Agent", () => {
  beforeAll(async () => {
    pooledFactory = new PooledConnectionFactory(innerFactory);
    configureAcp(pooledFactory);

    restateEnv = await RestateTestEnvironment.start({
      services: [AcpSession, AcpAgents, pubsubObject],
    });

    client = new FlamecastClient({
      ingressUrl: restateEnv.baseUrl(),
    });
  }, 60_000);

  afterAll(async () => {
    await pooledFactory?.shutdown();
    await restateEnv?.stop();
  });

  it("creates a session (blocking)", async () => {
    const { sessionId } = await client.newSession("echo-agent");
    expect(sessionId).toBeDefined();

    const status = await client.getStatus(sessionId);
    expect(status).toBeDefined();
    expect(status!.sessionId).toBe(sessionId);
  }, 30_000);

  it("sends a prompt and gets stopReason back (blocking)", async () => {
    const { sessionId } = await client.newSession("echo-agent");
    const result = await client.prompt(sessionId, "hello world");
    expect(result.stopReason).toBe("end_turn");
  }, 30_000);

  it("multi-turn on the same session", async () => {
    const { sessionId } = await client.newSession("echo-agent");

    const r1 = await client.prompt(sessionId, "turn 1");
    expect(r1.stopReason).toBe("end_turn");

    const r2 = await client.prompt(sessionId, "turn 2");
    expect(r2.stopReason).toBe("end_turn");
  }, 30_000);

  it("closes a session", async () => {
    const { sessionId } = await client.newSession("echo-agent");
    const result = await client.close(sessionId);
    expect(result.stopReason).toBe("cancelled");
  }, 30_000);
});
