/**
 * Process pool tests — validates that one agent process serves
 * multiple sessions with fresh ClientSideConnections per caller.
 *
 * Simulates what the Restate VO does:
 *   1. Pool spawns an agent process (transport)
 *   2. newSession handler: creates ClientSideConnection on the pooled
 *      transport, does initialize + newSession, gets sessionId
 *   3. prompt handler: creates a NEW ClientSideConnection on the same
 *      transport, does initialize + newSession (reuse sessionId?),
 *      calls prompt
 *
 * Key question: can multiple ClientSideConnections share one transport
 * stream? Or does each need its own stream?
 */

import { describe, it, expect } from "vitest";
import * as acp from "@agentclientprotocol/sdk";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createInMemoryTransport() {
  const clientToAgent = new TransformStream();
  const agentToClient = new TransformStream();

  return {
    clientStream: acp.ndJsonStream(
      clientToAgent.writable,
      agentToClient.readable,
    ),
    agentStream: acp.ndJsonStream(
      agentToClient.writable,
      clientToAgent.readable,
    ),
    async close() {
      await clientToAgent.writable.close().catch(() => {});
      await agentToClient.writable.close().catch(() => {});
    },
  };
}

/** Mock agent that tracks sessions and streams text back. */
function createMockAgent() {
  const sessions = new Map<string, { promptCount: number }>();
  let sessionCounter = 0;
  let agentConn: acp.AgentSideConnection | null = null;

  const agent: acp.Agent = {
    async initialize(params) {
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "mock", title: "Mock Agent", version: "1.0" },
      };
    },
    async newSession() {
      const id = `session-${++sessionCounter}`;
      sessions.set(id, { promptCount: 0 });
      return { sessionId: id };
    },
    async authenticate() {},
    async prompt(params) {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
      session.promptCount++;

      const text = params.prompt
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");

      if (agentConn) {
        await agentConn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `[turn ${session.promptCount}] ${text}`,
            },
          },
        });
      }
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  };

  return {
    agent,
    sessions,
    setConn(conn: acp.AgentSideConnection) { agentConn = conn; },
  };
}

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

describe("Agent process pool semantics", () => {
  it("one transport, one ClientSideConnection, multiple sessions", async () => {
    const transport = createInMemoryTransport();
    const mock = createMockAgent();

    new acp.AgentSideConnection((conn) => {
      mock.setConn(conn);
      return mock.agent;
    }, transport.agentStream);

    const client = makeClient();
    const conn = new acp.ClientSideConnection(() => client, transport.clientStream);

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    // Create two sessions on the same connection
    const s1 = await conn.newSession({ cwd: "/a", mcpServers: [] });
    const s2 = await conn.newSession({ cwd: "/b", mcpServers: [] });

    expect(s1.sessionId).toBe("session-1");
    expect(s2.sessionId).toBe("session-2");

    // Prompt on both sessions
    const r1 = await conn.prompt({
      sessionId: s1.sessionId,
      prompt: [{ type: "text", text: "hello from s1" }],
    });
    const r2 = await conn.prompt({
      sessionId: s2.sessionId,
      prompt: [{ type: "text", text: "hello from s2" }],
    });

    expect(r1.stopReason).toBe("end_turn");
    expect(r2.stopReason).toBe("end_turn");

    // Agent saw both sessions
    expect(mock.sessions.get("session-1")?.promptCount).toBe(1);
    expect(mock.sessions.get("session-2")?.promptCount).toBe(1);

    await transport.close();
  });

  it("one transport, fresh client callbacks per prompt", async () => {
    // Simulates Restate VO: each handler invocation creates a new
    // acp.Client with a fresh ctx. But we reuse the connection.
    const transport = createInMemoryTransport();
    const mock = createMockAgent();

    new acp.AgentSideConnection((conn) => {
      mock.setConn(conn);
      return mock.agent;
    }, transport.agentStream);

    // First "handler invocation" — newSession
    const updates1: string[] = [];
    const client1 = makeClient({
      async sessionUpdate(params) {
        if (params.update.sessionUpdate === "agent_message_chunk" &&
            params.update.content.type === "text") {
          updates1.push(params.update.content.text ?? "");
        }
      },
    });
    const conn = new acp.ClientSideConnection(() => client1, transport.clientStream);
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await conn.newSession({ cwd: "/test", mcpServers: [] });

    // First prompt with client1's callbacks
    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 1" }],
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(updates1).toEqual(["[turn 1] turn 1"]);

    // Second "handler invocation" — prompt with different callbacks
    // BUT we reuse the same conn — does the callback change?
    const updates2: string[] = [];
    // NOTE: we can't change the client on an existing connection.
    // The factory function passed to ClientSideConnection is called once.

    // Second prompt still uses client1's callbacks
    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    });
    await new Promise((r) => setTimeout(r, 50));

    // Both updates go to client1 (updates1), not updates2
    expect(updates1).toEqual(["[turn 1] turn 1", "[turn 2] turn 2"]);
    expect(updates2).toEqual([]); // client2 never received anything

    await transport.close();
  });

  it("one connection, mutable client delegation across turns", async () => {
    // The pattern: pool holds one ClientSideConnection with a delegating
    // client. Each handler invocation swaps the delegate before calling prompt.
    const transport = createInMemoryTransport();
    const mock = createMockAgent();

    new acp.AgentSideConnection((conn) => {
      mock.setConn(conn);
      return mock.agent;
    }, transport.agentStream);

    // Mutable delegate — the pooled connection routes through this
    let active: acp.Client = makeClient();

    const delegatingClient: acp.Client = {
      async requestPermission(params) { return active.requestPermission(params); },
      async sessionUpdate(params) { return active.sessionUpdate(params); },
    };

    const conn = new acp.ClientSideConnection(() => delegatingClient, transport.clientStream);
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    // "newSession handler" — sets up with callback set A
    const updatesA: string[] = [];
    active = makeClient({
      async sessionUpdate(params) {
        if (params.update.sessionUpdate === "agent_message_chunk" &&
            params.update.content.type === "text") {
          updatesA.push(params.update.content.text ?? "");
        }
      },
    });
    const session = await conn.newSession({ cwd: "/test", mcpServers: [] });

    // "prompt handler 1" — swaps to callback set B
    const updatesB: string[] = [];
    active = makeClient({
      async sessionUpdate(params) {
        if (params.update.sessionUpdate === "agent_message_chunk" &&
            params.update.content.type === "text") {
          updatesB.push(params.update.content.text ?? "");
        }
      },
    });
    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 1" }],
    });
    await new Promise((r) => setTimeout(r, 50));

    // "prompt handler 2" — swaps to callback set C
    const updatesC: string[] = [];
    active = makeClient({
      async sessionUpdate(params) {
        if (params.update.sessionUpdate === "agent_message_chunk" &&
            params.update.content.type === "text") {
          updatesC.push(params.update.content.text ?? "");
        }
      },
    });
    await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    });
    await new Promise((r) => setTimeout(r, 50));

    // Each turn's updates went to the active client at that time
    expect(updatesA).toEqual([]);           // newSession doesn't prompt
    expect(updatesB).toEqual(["[turn 1] turn 1"]);  // prompt 1
    expect(updatesC).toEqual(["[turn 2] turn 2"]);  // prompt 2

    await transport.close();
  });

});
