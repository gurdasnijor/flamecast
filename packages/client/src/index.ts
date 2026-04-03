/**
 * @flamecast/client — the single client for Restate ingress.
 *
 * Browser-safe (no server SDK). Works in browsers, edge, Node.
 * Optional adminUrl enables server-side features (listSessions, getSessionEvents).
 *
 *   import { createFlamecastClient } from "@flamecast/client";
 *
 *   // Browser — no admin access
 *   const client = createFlamecastClient({ ingressUrl: "/restate" });
 *
 *   // Server — with admin SQL
 *   const client = createFlamecastClient({
 *     ingressUrl: "http://localhost:18080",
 *     adminUrl: "http://localhost:9070",
 *   });
 */

import * as clients from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";
import type {
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

// ─── Types ──────────────────────────────────────────────────────────────────

export type RunStatus =
  | "created"
  | "in-progress"
  | "awaiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed";

export interface SessionStatus {
  sessionId: string;
  agentName: string;
  status: RunStatus;
  startedAt: string;
  lastUpdatedAt: string;
}

export interface SessionSummary {
  sessionId: string;
  agentName: string;
  status: string;
  startedAt: string;
  lastUpdatedAt: string;
}

export interface AgentInfo {
  name: string;
  description?: string;
}

export interface FlamecastClientConfig {
  /** Restate ingress URL. */
  ingressUrl: string;
  /** Restate admin URL. Enables listSessions/getSessionEvents. */
  adminUrl?: string;
  /** Optional bearer token. */
  apiKey?: string;
}

export type { NewSessionResponse, PromptRequest, PromptResponse, RequestPermissionResponse };

// ─── Service refs (no server SDK import) ────────────────────────────────────

const AcpSessionRef = { name: "AcpSession" } as Parameters<
  ReturnType<typeof clients.connect>["objectClient"]
>[0];

const AcpAgentsRef = { name: "AcpAgents" } as Parameters<
  ReturnType<typeof clients.connect>["serviceClient"]
>[0];

// ─── Admin SQL helper ───────────────────────────────────────────────────────

async function queryAdmin(
  adminUrl: string,
  sql: string,
  headers: Record<string, string>,
): Promise<Array<Record<string, string>>> {
  const res = await fetch(`${adminUrl}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Admin query failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    rows?: Array<Record<string, string>>;
  };
  return data.rows ?? [];
}

// ─── Client ─────────────────────────────────────────────────────────────────

export function createFlamecastClient(config: FlamecastClientConfig) {
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
  };

  const ingress = clients.connect({
    url: config.ingressUrl,
    headers: config.apiKey
      ? { Authorization: `Bearer ${config.apiKey}` }
      : undefined,
  });

  const pubsub = createPubsubClient({
    name: "pubsub",
    ingressUrl: config.ingressUrl,
    headers: config.apiKey
      ? { Authorization: `Bearer ${config.apiKey}` }
      : undefined,
    pullInterval: { milliseconds: 500 },
  });

  function sessionClient(sessionId: string) {
    return ingress.objectClient(AcpSessionRef, sessionId) as unknown as {
      startSession(input: {
        agentName: string;
        cwd: string;
        mcpServers: unknown[];
      }): Promise<NewSessionResponse>;
      sendPrompt(input: PromptRequest): Promise<PromptResponse>;
      getStatus(): Promise<SessionStatus | null>;
      resumeAgent(input: {
        awakeableId: string;
        optionId: string;
      }): Promise<RequestPermissionResponse>;
      terminateSession(): Promise<PromptResponse>;
    };
  }

  function agentsClient() {
    return ingress.serviceClient(AcpAgentsRef) as unknown as {
      listAgents(): Promise<AgentInfo[]>;
    };
  }

  return {
    // ── Session lifecycle ─────────────────────────────────────────────────

    async startSession(agentName: string, cwd = "/") {
      const sessionId = crypto.randomUUID();
      const result = await sessionClient(sessionId).startSession({
        agentName,
        cwd,
        mcpServers: [],
      });
      return { ...result, sessionId };
    },

    async sendPrompt(sessionId: string, text: string) {
      return sessionClient(sessionId).sendPrompt({
        sessionId,
        prompt: [{ type: "text" as const, text }],
      });
    },

    async getStatus(sessionId: string) {
      return sessionClient(sessionId).getStatus();
    },

    async resume(sessionId: string, awakeableId: string, optionId: string) {
      return sessionClient(sessionId).resumeAgent({ awakeableId, optionId });
    },

    async terminate(sessionId: string) {
      return sessionClient(sessionId).terminateSession();
    },

    // ── Agent discovery ───────────────────────────────────────────────────

    async listAgents() {
      return agentsClient().listAgents();
    },

    // ── Streaming (pubsub) ────────────────────────────────────────────────

    subscribe(
      sessionId: string,
      opts?: { offset?: number; signal?: AbortSignal },
    ) {
      return pubsub.pull({
        topic: `session:${sessionId}`,
        offset: opts?.offset ?? 0,
        signal: opts?.signal,
      });
    },

    subscribeSSE(
      sessionId: string,
      opts?: { offset?: number; signal?: AbortSignal },
    ) {
      return pubsub.sse({
        topic: `session:${sessionId}`,
        offset: opts?.offset ?? 0,
        signal: opts?.signal,
      });
    },

    // ── Admin SQL (requires adminUrl) ─────────────────────────────────────

    async listSessions(): Promise<SessionSummary[]> {
      if (!config.adminUrl) {
        throw new Error("listSessions requires adminUrl in client config");
      }
      const rows = await queryAdmin(
        config.adminUrl,
        `SELECT service_key, value_utf8 FROM state WHERE service_name = 'AcpSession' AND key = 'meta'`,
        authHeaders,
      );

      const sessions: SessionSummary[] = [];
      for (const row of rows) {
        try {
          const meta = JSON.parse(row.value_utf8) as SessionStatus;
          sessions.push({
            sessionId: row.service_key,
            agentName: meta.agentName,
            status: meta.status,
            startedAt: meta.startedAt,
            lastUpdatedAt: meta.lastUpdatedAt,
          });
        } catch {
          // skip malformed rows
        }
      }
      return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },

    async getSessionEvents(sessionId: string): Promise<unknown[]> {
      if (!config.adminUrl) {
        throw new Error("getSessionEvents requires adminUrl in client config");
      }
      const rows = await queryAdmin(
        config.adminUrl,
        `SELECT key, value_utf8 FROM state WHERE service_name = 'pubsub' AND service_key = 'session:${sessionId}' ORDER BY key`,
        authHeaders,
      );

      return rows
        .filter((row) => row.key.startsWith("m_"))
        .sort((a, b) => {
          const numA = parseInt(a.key.slice(2), 10);
          const numB = parseInt(b.key.slice(2), 10);
          return numA - numB;
        })
        .map((row) => {
          try {
            return JSON.parse(row.value_utf8);
          } catch {
            return null;
          }
        })
        .filter((e): e is unknown => e !== null);
    },
  };
}

export type FlamecastClient = ReturnType<typeof createFlamecastClient>;
