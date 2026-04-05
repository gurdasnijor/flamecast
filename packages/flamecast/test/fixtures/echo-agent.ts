#!/usr/bin/env node
/**
 * Minimal echo ACP agent for tests. No permissions, no tool calls.
 * Just echoes the prompt text back as agent_message_chunk.
 */

import * as acp from "@agentclientprotocol/sdk";
import { Writable } from "node:stream";

class EchoAgent implements acp.Agent {
  private connection: acp.AgentSideConnection;

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "echo-agent", title: "Echo Agent", version: "1.0" },
    };
  }

  async newSession(): Promise<acp.NewSessionResponse> {
    return { sessionId: crypto.randomUUID() };
  }

  async authenticate(): Promise<void> {}

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const text = params.prompt
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `echo: ${text}` },
      },
    });

    return { stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {}
}

// Run as stdio agent
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
new acp.AgentSideConnection((conn) => new EchoAgent(conn), stream);
