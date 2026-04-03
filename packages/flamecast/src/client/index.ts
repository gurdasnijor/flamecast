/**
 * @flamecast/client — typed client for Restate ingress.
 *
 * Browser-safe. Uses `import type` for VO definitions (erased at
 * compile time, no server SDK in bundle).
 *
 *   import { FlamecastClient } from "@flamecast/sdk/client";
 *
 *   const client = new FlamecastClient({ ingressUrl: "/restate" });
 *   const { sessionId } = await client.startSession("claude-acp");
 *   await client.sendPrompt(sessionId, "hello");
 */

import * as restate from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";

// Type-only imports — erased at compile time, no server SDK in bundle
import type {
  SessionState,
  RunStatus,
  AgentInfo,
} from "../index.js";
import type { AcpSession as AcpSessionDef } from "../session.js";
import type { AcpAgents as AcpAgentsDef } from "../agents.js";
const AcpSession: typeof AcpSessionDef = { name: "AcpSession" };
const AcpAgents: typeof AcpAgentsDef = { name: "AcpAgents" };

// Re-export shared types for consumers
export type { SessionState, RunStatus, AgentInfo };

// SessionSummary is a subset of SessionState for list results
export type SessionSummary = SessionState;

export interface FlamecastClientConfig {
  /** Restate ingress URL (or proxy path like "/restate"). */
  ingressUrl: string;
  /** Restate admin URL. Enables listSessions/getSessionEvents. */
  adminUrl?: string;
  /** Optional bearer token. */
  apiKey?: string;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class FlamecastClient {
  private ingress: ReturnType<typeof restate.connect>;
  private pubsub: ReturnType<typeof createPubsubClient>;
  private adminUrl?: string;
  private adminHeaders: Record<string, string>;

  constructor(config: FlamecastClientConfig) {
    this.adminUrl = config.adminUrl?.replace(/\/$/, "");
    this.adminHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
    };

    const authHeaders = config.apiKey
      ? { Authorization: `Bearer ${config.apiKey}` }
      : undefined;

    this.ingress = restate.connect({
      url: config.ingressUrl,
      headers: authHeaders,
    });

    this.pubsub = createPubsubClient({
      name: "pubsub",
      ingressUrl: config.ingressUrl,
      headers: authHeaders,
      pullInterval: { milliseconds: 500 },
    });
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  async startSession(agentName: string, cwd = "/") {
    const sessionId = crypto.randomUUID();
    const result = await this.ingress
      .objectClient(AcpSession, sessionId)
      .startSession({ agentName, cwd, mcpServers: [] });
    return { ...result, sessionId };
  }

  async sendPrompt(sessionId: string, text: string) {
    return this.ingress
      .objectClient(AcpSession, sessionId)
      .sendPrompt({ sessionId, prompt: [{ type: "text", text }] });
  }

  async getStatus(sessionId: string) {
    return this.ingress
      .objectClient(AcpSession, sessionId)
      .getStatus();
  }

  async resume(
    sessionId: string,
    awakeableId: string,
    optionId?: string,
    outcome: "selected" | "cancelled" = "selected",
  ) {
    return this.ingress
      .objectClient(AcpSession, sessionId)
      .resumeAgent({ awakeableId, optionId, outcome });
  }

  async terminate(sessionId: string) {
    return this.ingress
      .objectClient(AcpSession, sessionId)
      .terminateSession();
  }

  // ── Agent discovery ─────────────────────────────────────────────────────

  async listAgents() {
    return this.ingress
      .serviceClient(AcpAgents)
      .listAgents();
  }

  // ── Streaming (pubsub) ──────────────────────────────────────────────────

  subscribe(
    sessionId: string,
    opts?: { offset?: number; signal?: AbortSignal },
  ) {
    return this.pubsub.pull({
      topic: `session:${sessionId}`,
      offset: opts?.offset ?? 0,
      signal: opts?.signal,
    });
  }

  subscribeSSE(
    sessionId: string,
    opts?: { offset?: number; signal?: AbortSignal },
  ) {
    return this.pubsub.sse({
      topic: `session:${sessionId}`,
      offset: opts?.offset ?? 0,
      signal: opts?.signal,
    });
  }

  // ── Admin SQL (requires adminUrl) ───────────────────────────────────────

  async listSessions(): Promise<SessionSummary[]> {
    if (!this.adminUrl) {
      throw new Error("listSessions requires adminUrl in client config");
    }
    const rows = await this.queryAdmin(
      `SELECT service_key, value_utf8 FROM state WHERE service_name = 'AcpSession' AND key = 'meta'`,
    );
    const sessions: SessionSummary[] = [];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.value_utf8) as SessionState;
        sessions.push(meta);
      } catch {
        // skip malformed
      }
    }
    return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getSessionEvents(sessionId: string): Promise<unknown[]> {
    if (!this.adminUrl) {
      throw new Error("getSessionEvents requires adminUrl in client config");
    }
    const rows = await this.queryAdmin(
      `SELECT key, value_utf8 FROM state WHERE service_name = 'pubsub' AND service_key = 'session:${sessionId}' ORDER BY key`,
    );
    return rows
      .filter((row) => row.key.startsWith("m_"))
      .sort((a, b) => parseInt(a.key.slice(2), 10) - parseInt(b.key.slice(2), 10))
      .map((row) => { try { return JSON.parse(row.value_utf8); } catch { return null; } })
      .filter((e): e is unknown => e !== null);
  }

  private async queryAdmin(
    sql: string,
  ): Promise<Array<Record<string, string>>> {
    const res = await fetch(`${this.adminUrl}/query`, {
      method: "POST",
      headers: this.adminHeaders,
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Admin query failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { rows?: Array<Record<string, string>> };
    return data.rows ?? [];
  }
}
