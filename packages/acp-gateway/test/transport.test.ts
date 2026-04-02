/**
 * Transport-agnostic ACP client ↔ agent tests.
 *
 * Uses in-memory TransformStreams (no child processes, no HTTP) to prove
 * that any transport producing an acp.Stream can drive the full ACP
 * protocol: handshake, prompt, session updates, permissions, cancellation.
 *
 * Pattern borrowed from @agentclientprotocol/sdk's own acp.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as acp from "@agentclientprotocol/sdk";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a paired in-memory transport: two crossed TransformStreams
 * wired through ndJsonStream. Returns { clientStream, agentStream }.
 *
 * This is the seam — any real transport (stdio, WS, HTTP+SSE) just needs
 * to produce the same Stream shape.
 */
function createStreamPair(): {
  clientStream: acp.Stream;
  agentStream: acp.Stream;
  clientToAgent: TransformStream;
  agentToClient: TransformStream;
} {
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
    clientToAgent,
    agentToClient,
  };
}

/** Minimal Agent impl that echoes prompts back. */
class EchoAgent implements acp.Agent {
  public lastPrompt: acp.PromptRequest | null = null;
  public conn: acp.AgentSideConnection | null = null;

  async initialize(
    params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(
    _params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    return { sessionId: "test-session-1" };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<void> {}

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.lastPrompt = params;

    // Echo back via sessionUpdate notifications
    const text = params.prompt
      .filter((p): p is acp.PromptRequest["prompt"][number] & { type: "text" } => p.type === "text")
      .map((p) => p.text)
      .join("");

    if (this.conn) {
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `echo: ${text}` },
        },
      });
    }

    return { stopReason: "end_turn" };
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {}
}

/** Minimal Client impl that collects session updates. */
class CollectorClient implements acp.Client {
  public updates: acp.SessionNotification[] = [];
  public permissionHandler:
    | ((
        params: acp.RequestPermissionRequest,
      ) => Promise<acp.RequestPermissionResponse>)
    | null = null;

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (this.permissionHandler) {
      return this.permissionHandler(params);
    }
    // Auto-approve first option
    return {
      outcome: { outcome: "selected", optionId: params.options[0].optionId },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Transport-agnostic ACP protocol", () => {
  let clientStream: acp.Stream;
  let agentStream: acp.Stream;
  let clientToAgent: TransformStream;
  let agentToClient: TransformStream;

  beforeEach(() => {
    ({ clientStream, agentStream, clientToAgent, agentToClient } =
      createStreamPair());
  });

  // ── 1. Handshake ─────────────────────────────────────────────────────────

  it("completes initialize + newSession handshake", async () => {
    const client = new CollectorClient();
    const agent = new EchoAgent();

    const clientConn = new acp.ClientSideConnection(
      () => client,
      clientStream,
    );
    const _agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    const initResult = await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test-client", title: "Test", version: "0.0.1" },
    });

    expect(initResult.protocolVersion).toBe(acp.PROTOCOL_VERSION);

    const sessionResult = await clientConn.newSession({
      cwd: "/tmp/test",
      mcpServers: [],
    });

    expect(sessionResult.sessionId).toBe("test-session-1");
  });

  // ── 2. Prompt round-trip ─────────────────────────────────────────────────

  it("sends prompt and receives response", async () => {
    const client = new CollectorClient();
    const agent = new EchoAgent();

    const clientConn = new acp.ClientSideConnection(
      () => client,
      clientStream,
    );
    const _agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    const result = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello world" }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(agent.lastPrompt?.prompt).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  // ── 3. Session updates (streaming notifications) ─────────────────────────

  it("receives session update notifications during prompt", async () => {
    const client = new CollectorClient();
    const agent = new EchoAgent();

    const clientConn = new acp.ClientSideConnection(
      () => client,
      clientStream,
    );
    const _agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "ping" }],
    });

    // Wait for notifications to propagate
    await new Promise((r) => setTimeout(r, 50));

    expect(client.updates.length).toBeGreaterThan(0);

    const textUpdate = client.updates.find(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdate).toBeDefined();
    expect(
      textUpdate!.update.sessionUpdate === "agent_message_chunk" &&
        textUpdate!.update.content.type === "text"
        ? textUpdate!.update.content.text
        : undefined,
    ).toBe("echo: ping");
  });

  // ── 4. Permission request flow ───────────────────────────────────────────

  it("handles permission request and response", async () => {
    const permissionLog: string[] = [];
    const client = new CollectorClient();
    client.permissionHandler = async (params) => {
      permissionLog.push(
        `permission: ${params.toolCall.title} → ${params.options.map((o) => o.name).join(",")}`,
      );
      return {
        outcome: { outcome: "selected", optionId: params.options[0].optionId },
      };
    };

    // Agent that requests permission before responding
    class PermissionAgent implements acp.Agent {
      conn: acp.AgentSideConnection | null = null;

      async initialize(
        params: acp.InitializeRequest,
      ): Promise<acp.InitializeResponse> {
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: false },
        };
      }
      async newSession(): Promise<acp.NewSessionResponse> {
        return { sessionId: "perm-session" };
      }
      async authenticate(): Promise<void> {}
      async prompt(
        params: acp.PromptRequest,
      ): Promise<acp.PromptResponse> {
        // Request permission from client
        const permResult = await this.conn!.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: "tool-1",
            title: "Run dangerous command",
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

        expect(permResult.outcome.outcome).toBe("selected");
        expect(permResult.outcome.optionId).toBe("allow");

        return { stopReason: "end_turn" };
      }
      async cancel(): Promise<void> {}
    }

    const agent = new PermissionAgent();
    const clientConn = new acp.ClientSideConnection(
      () => client,
      clientStream,
    );
    const _agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    const result = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "do the thing" }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(permissionLog).toEqual([
      "permission: Run dangerous command → Allow,Deny",
    ]);
  });

  // ── 5. Cancellation ──────────────────────────────────────────────────────

  it("cancels an in-progress prompt", async () => {
    const cancelLog: string[] = [];
    const client = new CollectorClient();

    // Agent that hangs until cancelled
    class SlowAgent implements acp.Agent {
      conn: acp.AgentSideConnection | null = null;
      private cancelResolve: (() => void) | null = null;

      async initialize(
        params: acp.InitializeRequest,
      ): Promise<acp.InitializeResponse> {
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: false },
        };
      }
      async newSession(): Promise<acp.NewSessionResponse> {
        return { sessionId: "slow-session" };
      }
      async authenticate(): Promise<void> {}
      async prompt(): Promise<acp.PromptResponse> {
        // Block until cancel arrives
        await new Promise<void>((resolve) => {
          this.cancelResolve = resolve;
        });
        return { stopReason: "cancelled" };
      }
      async cancel(params: acp.CancelNotification): Promise<void> {
        cancelLog.push(`cancelled: ${params.sessionId}`);
        this.cancelResolve?.();
      }
    }

    const agent = new SlowAgent();
    const clientConn = new acp.ClientSideConnection(
      () => client,
      clientStream,
    );
    const _agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    // Start prompt (will block)
    const promptPromise = clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "slow task" }],
    });

    // Give it a tick to start, then cancel
    await new Promise((r) => setTimeout(r, 20));
    await clientConn.cancel({ sessionId: session.sessionId });

    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
    expect(cancelLog).toEqual(["cancelled: slow-session"]);
  });

  // ── 6. Connection close ──────────────────────────────────────────────────

  it("signals connection close when streams end", async () => {
    const closeLog: string[] = [];
    const client = new CollectorClient();
    const agent = new EchoAgent();

    const clientConn = new acp.ClientSideConnection(
      () => client,
      clientStream,
    );
    const agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    clientConn.signal.addEventListener("abort", () => {
      closeLog.push("client closed");
    });
    agentConn.signal.addEventListener("abort", () => {
      closeLog.push("agent closed");
    });

    expect(clientConn.signal.aborted).toBe(false);
    expect(agentConn.signal.aborted).toBe(false);

    // Close the raw streams
    await clientToAgent.writable.close();
    await agentToClient.writable.close();

    await clientConn.closed;
    await agentConn.closed;

    expect(clientConn.signal.aborted).toBe(true);
    expect(agentConn.signal.aborted).toBe(true);
    expect(closeLog).toContain("client closed");
    expect(closeLog).toContain("agent closed");
  });

  // ── 7. Multi-turn conversation ───────────────────────────────────────────

  it("supports multiple prompt turns on the same session", async () => {
    const client = new CollectorClient();
    const agent = new EchoAgent();

    const clientConn = new acp.ClientSideConnection(
      () => client,
      clientStream,
    );
    const _agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    // Turn 1
    const r1 = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 1" }],
    });
    expect(r1.stopReason).toBe("end_turn");

    // Turn 2
    const r2 = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    });
    expect(r2.stopReason).toBe("end_turn");

    // Turn 3
    const r3 = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "turn 3" }],
    });
    expect(r3.stopReason).toBe("end_turn");

    // Agent saw all three
    expect(agent.lastPrompt?.prompt).toEqual([
      { type: "text", text: "turn 3" },
    ]);

    // Wait for notifications
    await new Promise((r) => setTimeout(r, 50));

    // Client received updates from all turns
    const textUpdates = client.updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdates).toHaveLength(3);
  });

  // ── 8. Tool call updates ─────────────────────────────────────────────────

  it("receives tool call session updates", async () => {
    const client = new CollectorClient();

    class ToolAgent implements acp.Agent {
      conn: acp.AgentSideConnection | null = null;

      async initialize(
        params: acp.InitializeRequest,
      ): Promise<acp.InitializeResponse> {
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: false },
        };
      }
      async newSession(): Promise<acp.NewSessionResponse> {
        return { sessionId: "tool-session" };
      }
      async authenticate(): Promise<void> {}
      async prompt(
        params: acp.PromptRequest,
      ): Promise<acp.PromptResponse> {
        // Send tool_call update
        await this.conn!.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "Read file",
            kind: "read",
            status: "in_progress",
          },
        });

        // Send tool_call_update
        await this.conn!.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            title: "Read file",
            kind: "read",
            status: "completed",
          },
        });

        // Send text response
        await this.conn!.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "I read the file" },
          },
        });

        return { stopReason: "end_turn" };
      }
      async cancel(): Promise<void> {}
    }

    const agent = new ToolAgent();
    const clientConn = new acp.ClientSideConnection(
      () => client,
      clientStream,
    );
    const _agentConn = new acp.AgentSideConnection((conn) => {
      agent.conn = conn;
      return agent;
    }, agentStream);

    await clientConn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConn.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });

    const result = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "read something" }],
    });

    expect(result.stopReason).toBe("end_turn");

    await new Promise((r) => setTimeout(r, 50));

    const toolCalls = client.updates.filter(
      (u) =>
        u.update.sessionUpdate === "tool_call" ||
        u.update.sessionUpdate === "tool_call_update",
    );
    expect(toolCalls).toHaveLength(2);

    const textUpdates = client.updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(textUpdates).toHaveLength(1);
  });
});
