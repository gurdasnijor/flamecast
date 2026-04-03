/**
 * AgentConnectionFactory tests — validates ACP handshake + prompt flow
 * using in-memory transports with mock agents.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import type { TransportConnection } from "../src/transport.js";
import type { AgentConnectionFactory, AgentConnectionResult } from "../src/acp-client.js";

// ─── In-memory factory ──────────────────────────────────────────────────────

interface InMemoryAgent {
  agent: acp.Agent;
  conn: acp.AgentSideConnection | null;
}

function createEchoAgent(name: string): () => InMemoryAgent {
  return () => {
    const memAgent: InMemoryAgent = {
      conn: null,
      agent: {
        async initialize(params) {
          return {
            protocolVersion: params.protocolVersion,
            agentCapabilities: { loadSession: false },
            agentInfo: { name, title: name, version: "1.0.0" },
          };
        },
        async newSession() {
          return { sessionId: `${name}-session` };
        },
        async authenticate() {},
        async prompt(params) {
          const text = params.prompt
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("");

          if (memAgent.conn) {
            await memAgent.conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `[${name}] ${text}` },
              },
            });
          }
          return { stopReason: "end_turn" };
        },
        async cancel() {},
      },
    };
    return memAgent;
  };
}

class InMemoryFactory implements AgentConnectionFactory {
  private agents = new Map<string, () => InMemoryAgent>();

  register(name: string, create: () => InMemoryAgent) {
    this.agents.set(name, create);
  }

  async connect(agentName: string, client: acp.Client): Promise<AgentConnectionResult> {
    const createAgent = this.agents.get(agentName);
    if (!createAgent) throw new Error(`No agent: ${agentName}`);

    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();

    const clientStream = acp.ndJsonStream(clientToAgent.writable, agentToClient.readable);
    const agentStream = acp.ndJsonStream(agentToClient.writable, clientToAgent.readable);

    const memAgent = createAgent();
    new acp.AgentSideConnection((conn) => {
      memAgent.conn = conn;
      return memAgent.agent;
    }, agentStream);

    const acpConn = new acp.ClientSideConnection(() => client, clientStream);

    return {
      conn: acpConn,
      close: async () => {
        await clientToAgent.writable.close().catch(() => {});
        await agentToClient.writable.close().catch(() => {});
      },
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeClient(overrides?: Partial<acp.Client>): acp.Client {
  return {
    async requestPermission(params) {
      return {
        outcome: { outcome: "selected", optionId: params.options[0].optionId },
      };
    },
    async sessionUpdate() {},
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AgentConnectionFactory", () => {
  let factory: InMemoryFactory;

  beforeEach(() => {
    factory = new InMemoryFactory();
    factory.register("echo-1", createEchoAgent("echo-1"));
    factory.register("echo-2", createEchoAgent("echo-2"));
  });

  it("connects and completes ACP handshake", async () => {
    const { conn, close } = await factory.connect("echo-1", makeClient());

    const init = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(session.sessionId).toBe("echo-1-session");

    await close();
  });

  it("throws on unknown agent", async () => {
    await expect(
      factory.connect("nonexistent", makeClient()),
    ).rejects.toThrow();
  });

  it("sends prompt and receives response", async () => {
    const { conn, close } = await factory.connect("echo-1", makeClient());
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    const result = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    expect(result.stopReason).toBe("end_turn");
    await close();
  });

  it("receives session updates via client callback", async () => {
    const updates: acp.SessionNotification[] = [];
    const { conn, close } = await factory.connect(
      "echo-1",
      makeClient({ async sessionUpdate(u) { updates.push(u); } }),
    );

    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    await new Promise((r) => setTimeout(r, 50));

    const textUpdate = updates.find(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdate).toBeDefined();

    await close();
  });

  it("connects to multiple agents independently", async () => {
    const a1 = await factory.connect("echo-1", makeClient());
    const a2 = await factory.connect("echo-2", makeClient());

    await a1.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await a2.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    const s1 = await a1.conn.newSession({ cwd: "/tmp", mcpServers: [] });
    const s2 = await a2.conn.newSession({ cwd: "/tmp", mcpServers: [] });

    expect(s1.sessionId).toBe("echo-1-session");
    expect(s2.sessionId).toBe("echo-2-session");

    await a1.close();
    await a2.close();
  });
});
