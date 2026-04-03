/**
 * Session host — manages persistent agent processes keyed by sessionId.
 *
 * Each session gets its own stdio process. The process lives until
 * explicitly closed or the host shuts down. Multiple connections
 * (handler invocations) route to the same process via sessionId.
 *
 * Usage:
 *   const host = createSessionHost("npx", ["@agentclientprotocol/claude-agent-acp"])
 *   const session = host.getOrCreate("session-123")
 *   // pipe inbound transport to session.stream
 */

import { fromStdio, type StdioOptions } from "./transports/stdio.js";
import type * as acp from "@agentclientprotocol/sdk";

interface Session {
  stream: acp.Stream;
  close(): Promise<void>;
}

export function createSessionHost(
  cmd: string,
  args: string[] = [],
  env?: Record<string, string>,
) {
  const sessions = new Map<string, Session>();

  function getOrCreate(sessionId: string): Session {
    const existing = sessions.get(sessionId);
    if (existing) return existing;

    const stream = fromStdio({ cmd, args, env, label: sessionId });
    const session: Session = {
      stream,
      async close() {
        sessions.delete(sessionId);
      },
    };
    sessions.set(sessionId, session);
    return session;
  }

  function get(sessionId: string): Session | undefined {
    return sessions.get(sessionId);
  }

  async function close(sessionId: string) {
    await sessions.get(sessionId)?.close();
  }

  async function closeAll() {
    await Promise.all([...sessions.values()].map((s) => s.close()));
    sessions.clear();
  }

  return { getOrCreate, get, close, closeAll };
}
