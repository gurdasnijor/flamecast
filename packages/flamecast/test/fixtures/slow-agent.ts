#!/usr/bin/env node
/**
 * Slow ACP agent for cancel tests. Delays 5s before responding to prompt.
 * Respects cancel — returns stopReason: cancelled if cancelled during delay.
 */

import * as acp from "@agentclientprotocol/sdk";
import { Writable } from "node:stream";

class SlowAgent implements acp.Agent {
  private connection: acp.AgentSideConnection;
  private cancelledSessions = new Set<string>();

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "slow-agent", title: "Slow Agent", version: "1.0" },
    };
  }

  async newSession(): Promise<acp.NewSessionResponse> {
    return { sessionId: crypto.randomUUID() };
  }

  async authenticate(): Promise<void> {}

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.cancelledSessions.delete(params.sessionId);

    // Wait 5s, checking for cancellation every 100ms
    for (let i = 0; i < 50; i++) {
      if (this.cancelledSessions.has(params.sessionId)) {
        return { stopReason: "cancelled" };
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const text = params.prompt
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `slow: ${text}` },
      },
    });

    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.cancelledSessions.add(params.sessionId);
  }
}

const input = Writable.toWeb(process.stdout);
const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) => {
      controller.enqueue(new Uint8Array(chunk));
    });
    process.stdin.on("end", () => controller.close());
  },
});

const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((conn) => new SlowAgent(conn), stream);
