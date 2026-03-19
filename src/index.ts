#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { ExampleClient } from "./client.js";
import {
  createExampleAgentProcess,
  getAgentTransport,
  startCodexAgentProcess,
} from "./transport.js";

async function main({
  agent = "example",
  prompt = "Hello, agent!",
}: {
  agent?: "codex" | "example";
  prompt?: string;
}) {
  // Create the client connection
  const client = new ExampleClient();
  const agentProcess = agent === "codex" ? startCodexAgentProcess() : createExampleAgentProcess();
  const { input, output } = getAgentTransport(agentProcess);
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  try {
    // Initialize the connection
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      // This is the *client* capabilities that are told to the agent
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    });

    console.log(`✅ Connected to agent (protocol v${initResult.protocolVersion})`);

    // Create a new session
    const sessionResult = await connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    console.log(`📝 Created session: ${sessionResult.sessionId}`);
    console.log(`💬 User: ${prompt}\n`);
    process.stdout.write(" ");

    // Send a test prompt
    const promptResult = await connection.prompt({
      sessionId: sessionResult.sessionId,
      prompt: [
        {
          type: "text",
          text: prompt,
        },
      ],
    });

    console.log(`\n\n✅ Agent completed with: ${promptResult.stopReason}`);
  } catch (error) {
    console.error("[Client] Error:", error);
  } finally {
    agentProcess.kill();
    process.exit(0);
  }
}

main({ agent: "codex", prompt: "what files are in the current directory?" }).catch(console.error);
