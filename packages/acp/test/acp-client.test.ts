/**
 * AcpClient — transport-agnostic multiplexing client.
 *
 * The AcpClient replaces the gateway HTTP server. Instead of:
 *   Consumer → HTTP → acp-gateway (Hono) → spawner → Transport → Agent
 *
 * You get:
 *   Consumer → AcpClient → Transport → Agent 1
 *                         → Transport → Agent 2
 *
 * The AcpClient manages per-agent transport connections, ACP handshakes,
 * sessions, and exposes a clean API for prompting any registered agent.
 *
 * All tests use in-memory transports — no child processes, no HTTP.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import type { Transport, TransportConnection } from "../src/transport.js";
import type { AcpClient } from "../src/acp-client.js";

// ─── In-memory transport ────────────────────────────────────────────────────

/**
 * An in-memory transport that connects to a pre-wired AgentSideConnection.
 * The "server side" is set up in advance; connect() returns the client side.
 */
interface InMemoryAgent {
  agent: acp.Agent;
  /** Set by AgentSideConnection constructor */
  conn: acp.AgentSideConnection | null;
}

class InMemoryTransport implements Transport<{ agentName: string }> {
  private agents = new Map<
    string,
    {
      createAgent: () => InMemoryAgent;
    }
  >();

  register(agentName: string, createAgent: () => InMemoryAgent) {
    this.agents.set(agentName, { createAgent });
  }

  async connect(opts: { agentName: string }): Promise<TransportConnection> {
    const entry = this.agents.get(opts.agentName);
    if (!entry) throw new Error(`No agent registered: ${opts.agentName}`);

    const ac = new AbortController();
    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();

    const clientStream = acp.ndJsonStream(
      clientToAgent.writable,
      agentToClient.readable,
    );
    const agentStream = acp.ndJsonStream(
      agentToClient.writable,
      clientToAgent.readable,
    );

    const memAgent = entry.createAgent();
    const _agentConn = new acp.AgentSideConnection((conn) => {
      memAgent.conn = conn;
      return memAgent.agent;
    }, agentStream);

    return {
      stream: clientStream,
      signal: ac.signal,
      async close() {
        ac.abort();
        await clientToAgent.writable.close().catch(() => {});
        await agentToClient.writable.close().catch(() => {});
      },
    };
  }
}

// ─── Mock Agents ─────────────────────────────────────────────────────────────

function createEchoAgent(name: string): () => InMemoryAgent {
  return () => {
    const memAgent: InMemoryAgent = {
      conn: null,
      agent: {
        async initialize(
          params: acp.InitializeRequest,
        ): Promise<acp.InitializeResponse> {
          return {
            protocolVersion: params.protocolVersion,
            agentCapabilities: { loadSession: false },
            agentInfo: { name, title: name, version: "1.0.0" },
          };
        },
        async newSession(): Promise<acp.NewSessionResponse> {
          return { sessionId: `${name}-session` };
        },
        async authenticate(): Promise<void> {},
        async prompt(
          params: acp.PromptRequest,
        ): Promise<acp.PromptResponse> {
          const text = params.prompt
            .filter(
              (
                p,
              ): p is acp.PromptRequest["prompt"][number] & {
                type: "text";
              } => p.type === "text",
            )
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
        async cancel(): Promise<void> {},
      },
    };
    return memAgent;
  };
}

function createPermissionAgent(): () => InMemoryAgent {
  return () => {
    const memAgent: InMemoryAgent = {
      conn: null,
      agent: {
        async initialize(
          params: acp.InitializeRequest,
        ): Promise<acp.InitializeResponse> {
          return {
            protocolVersion: params.protocolVersion,
            agentCapabilities: { loadSession: false },
          };
        },
        async newSession(): Promise<acp.NewSessionResponse> {
          return { sessionId: "perm-session" };
        },
        async authenticate(): Promise<void> {},
        async prompt(
          params: acp.PromptRequest,
        ): Promise<acp.PromptResponse> {
          const permResult = await memAgent.conn!.requestPermission({
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: "tool-1",
              title: "Dangerous operation",
              kind: "execute",
              status: "pending",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: "rm -rf /" },
                },
              ],
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          });

          if (memAgent.conn) {
            await memAgent.conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: `permission: ${permResult.outcome.optionId}`,
                },
              },
            });
          }
          return { stopReason: "end_turn" };
        },
        async cancel(): Promise<void> {},
      },
    };
    return memAgent;
  };
}

function createSlowAgent(): () => InMemoryAgent {
  return () => {
    let cancelResolve: (() => void) | null = null;
    const memAgent: InMemoryAgent = {
      conn: null,
      agent: {
        async initialize(
          params: acp.InitializeRequest,
        ): Promise<acp.InitializeResponse> {
          return {
            protocolVersion: params.protocolVersion,
            agentCapabilities: { loadSession: false },
          };
        },
        async newSession(): Promise<acp.NewSessionResponse> {
          return { sessionId: "slow-session" };
        },
        async authenticate(): Promise<void> {},
        async prompt(): Promise<acp.PromptResponse> {
          await new Promise<void>((resolve) => {
            cancelResolve = resolve;
          });
          return { stopReason: "cancelled" };
        },
        async cancel(): Promise<void> {
          cancelResolve?.();
        },
      },
    };
    return memAgent;
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AcpClient", () => {
  let transport: InMemoryTransport;
  let client: AcpClient;

  beforeEach(async () => {
    transport = new InMemoryTransport();
    transport.register("echo-1", createEchoAgent("echo-1"));
    transport.register("echo-2", createEchoAgent("echo-2"));
    transport.register("perm-agent", createPermissionAgent());
    transport.register("slow-agent", createSlowAgent());

    // Dynamically import to get the actual implementation
    // (will fail until we implement it)
    const mod = await import("../src/acp-client.js");
    client = new mod.AcpClient({ transport });
  });

  afterEach(async () => {
    await client.closeAll();
  });

  // ── Basic connectivity ───────────────────────────────────────────────────

  it("connects to an agent and creates a session", async () => {
    const session = await client.connect("echo-1");

    expect(session.sessionId).toBe("echo-1-session");
    expect(session.agentName).toBe("echo-1");
  });

  it("throws when connecting to unknown agent", async () => {
    await expect(client.connect("nonexistent")).rejects.toThrow();
  });

  // ── Prompting ────────────────────────────────────────────────────────────

  it("sends prompt and receives response", async () => {
    const session = await client.connect("echo-1");
    const result = await client.prompt(session.sessionId, "hello");

    expect(result.stopReason).toBe("end_turn");
  });

  it("collects session update text during prompt", async () => {
    const updates: acp.SessionNotification[] = [];
    const session = await client.connect("echo-1", {
      onSessionUpdate: (update) => updates.push(update),
    });

    await client.prompt(session.sessionId, "hello");
    await new Promise((r) => setTimeout(r, 50));

    const textUpdate = updates.find(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdate).toBeDefined();
    const content = textUpdate!.update;
    expect(
      content.sessionUpdate === "agent_message_chunk" &&
        content.content.type === "text"
        ? content.content.text
        : undefined,
    ).toBe("[echo-1] hello");
  });

  // ── Multiplexing ─────────────────────────────────────────────────────────

  it("connects to multiple agents independently", async () => {
    const s1 = await client.connect("echo-1");
    const s2 = await client.connect("echo-2");

    expect(s1.sessionId).toBe("echo-1-session");
    expect(s2.sessionId).toBe("echo-2-session");
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  it("routes prompts to the correct agent", async () => {
    const updates1: acp.SessionNotification[] = [];
    const updates2: acp.SessionNotification[] = [];

    const s1 = await client.connect("echo-1", {
      onSessionUpdate: (u) => updates1.push(u),
    });
    const s2 = await client.connect("echo-2", {
      onSessionUpdate: (u) => updates2.push(u),
    });

    await client.prompt(s1.sessionId, "msg for agent 1");
    await client.prompt(s2.sessionId, "msg for agent 2");
    await new Promise((r) => setTimeout(r, 50));

    const text1 = updates1
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) =>
        u.update.sessionUpdate === "agent_message_chunk" &&
        u.update.content.type === "text"
          ? u.update.content.text
          : "",
      );
    const text2 = updates2
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) =>
        u.update.sessionUpdate === "agent_message_chunk" &&
        u.update.content.type === "text"
          ? u.update.content.text
          : "",
      );

    expect(text1).toEqual(["[echo-1] msg for agent 1"]);
    expect(text2).toEqual(["[echo-2] msg for agent 2"]);
  });

  it("prompts multiple agents concurrently", async () => {
    const s1 = await client.connect("echo-1");
    const s2 = await client.connect("echo-2");

    const [r1, r2] = await Promise.all([
      client.prompt(s1.sessionId, "concurrent 1"),
      client.prompt(s2.sessionId, "concurrent 2"),
    ]);

    expect(r1.stopReason).toBe("end_turn");
    expect(r2.stopReason).toBe("end_turn");
  });

  // ── Multi-turn ───────────────────────────────────────────────────────────

  it("supports multi-turn on same session", async () => {
    const updates: acp.SessionNotification[] = [];
    const session = await client.connect("echo-1", {
      onSessionUpdate: (u) => updates.push(u),
    });

    await client.prompt(session.sessionId, "turn 1");
    await client.prompt(session.sessionId, "turn 2");
    await client.prompt(session.sessionId, "turn 3");
    await new Promise((r) => setTimeout(r, 50));

    const texts = updates
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) =>
        u.update.sessionUpdate === "agent_message_chunk" &&
        u.update.content.type === "text"
          ? u.update.content.text
          : "",
      );

    expect(texts).toEqual([
      "[echo-1] turn 1",
      "[echo-1] turn 2",
      "[echo-1] turn 3",
    ]);
  });

  // ── Permission handling ──────────────────────────────────────────────────

  it("handles permission requests via callback", async () => {
    const permLog: string[] = [];
    const session = await client.connect("perm-agent", {
      onPermissionRequest: async (params) => {
        permLog.push(
          `${params.toolCall.title}: ${params.options.map((o) => o.name).join(",")}`,
        );
        return {
          outcome: { outcome: "selected", optionId: "allow" },
        };
      },
    });

    const result = await client.prompt(session.sessionId, "do it");

    expect(result.stopReason).toBe("end_turn");
    expect(permLog).toEqual(["Dangerous operation: Allow,Deny"]);
  });

  it("auto-approves first option when no permission handler set", async () => {
    const updates: acp.SessionNotification[] = [];
    const session = await client.connect("perm-agent", {
      onSessionUpdate: (u) => updates.push(u),
    });

    const result = await client.prompt(session.sessionId, "do it");

    expect(result.stopReason).toBe("end_turn");

    await new Promise((r) => setTimeout(r, 50));
    const text = updates
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) =>
        u.update.sessionUpdate === "agent_message_chunk" &&
        u.update.content.type === "text"
          ? u.update.content.text
          : "",
      );
    expect(text).toEqual(["permission: allow"]);
  });

  // ── Cancellation ─────────────────────────────────────────────────────────

  it("cancels an in-progress prompt", async () => {
    const session = await client.connect("slow-agent");

    const promptPromise = client.prompt(session.sessionId, "slow task");

    await new Promise((r) => setTimeout(r, 20));
    await client.cancel(session.sessionId);

    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  it("closes a single session", async () => {
    const session = await client.connect("echo-1");
    await client.close(session.sessionId);

    // Prompting a closed session should throw
    await expect(
      client.prompt(session.sessionId, "after close"),
    ).rejects.toThrow();
  });

  it("closeAll cleans up all sessions", async () => {
    const s1 = await client.connect("echo-1");
    const s2 = await client.connect("echo-2");

    await client.closeAll();

    await expect(client.prompt(s1.sessionId, "nope")).rejects.toThrow();
    await expect(client.prompt(s2.sessionId, "nope")).rejects.toThrow();
  });

  it("lists active sessions", async () => {
    const s1 = await client.connect("echo-1");
    const s2 = await client.connect("echo-2");

    const sessions = client.sessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.agentName).sort()).toEqual([
      "echo-1",
      "echo-2",
    ]);

    await client.close(s1.sessionId);
    expect(client.sessions()).toHaveLength(1);
    expect(client.sessions()[0].sessionId).toBe(s2.sessionId);
  });
});
