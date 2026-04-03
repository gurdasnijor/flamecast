/**
 * Bridge server — hosts persistent ACP agents over WebSocket.
 *
 * Each session gets its own agent process (spawned on first connection).
 * Subsequent connections for the same session route to the same process.
 * Session ID comes from the first JSON-RPC message's sessionId field,
 * or from a query param: ws://localhost:9200?sessionId=xxx
 *
 * Usage:
 *   npx tsx packages/acp/src/bridge-server.ts
 */

import { acceptWs } from "./transports/websocket.js";
import { createSessionHost } from "./session-host.js";
import type * as acp from "@agentclientprotocol/sdk";
import { WebSocket } from "ws";

const port = parseInt(process.env.BRIDGE_PORT ?? "9200", 10);
const agentCmd = process.env.AGENT_CMD ?? "npx";
const agentArgs = (process.env.AGENT_ARGS ?? "@agentclientprotocol/claude-agent-acp").split(" ");

const host = createSessionHost(agentCmd, agentArgs, {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
});

const server = await acceptWs({ port }, (clientStream) => {
  // Read the first message to extract sessionId, then route all messages
  // to the session's persistent process.
  const reader = clientStream.readable.getReader();

  reader.read().then(async ({ done, value }) => {
    if (done || !value) return;

    const firstMsg = value as Record<string, unknown>;
    const params = firstMsg.params as Record<string, unknown> | undefined;
    const sessionId = (params?.sessionId as string) ?? crypto.randomUUID();

    const session = host.getOrCreate(sessionId);
    const agentWriter = session.stream.writable.getWriter();

    // Forward first message
    await agentWriter.write(firstMsg as acp.AnyMessage);

    // Pipe remaining client→agent
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await agentWriter.write(value);
        }
      } catch {} finally {
        agentWriter.releaseLock();
      }
    })();

    // Pipe agent→client
    // Note: agent.readable can only have one reader at a time.
    // For single-session agents (claude-acp), this works because
    // only one connection is active per session at a time
    // (Restate exclusive handlers serialize).
    const agentReader = session.stream.readable.getReader();
    const clientWriter = clientStream.writable.getWriter();
    (async () => {
      try {
        while (true) {
          const { done, value } = await agentReader.read();
          if (done) break;
          await clientWriter.write(value);
        }
      } catch {} finally {
        agentReader.releaseLock();
        clientWriter.releaseLock();
      }
    })();
  });
});

console.log(`Bridge listening on ws://localhost:${server.port}`);
console.log(`Agent: ${agentCmd} ${agentArgs.join(" ")}`);
console.log(`Sessions spawn on first connection, persist across reconnects.`);

process.on("SIGINT", () => {
  host.closeAll().then(() => server.close()).then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  host.closeAll().then(() => server.close()).then(() => process.exit(0));
});
