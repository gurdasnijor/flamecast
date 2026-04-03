/**
 * Typed Restate client for AcpSession.
 *
 * Provides two flavors:
 *   - createAcpClient({ ingressUrl, adminUrl }) — for external callers (HTTP)
 *   - createAcpCtxClient(ctx) — for Restate handler-to-handler calls
 *
 * The external client uses Restate ingress for handler calls and the
 * admin SQL API for cross-session queries (listSessions, getSessionEvents).
 *
 *   const acp = createAcpClient({
 *     ingressUrl: "http://localhost:18080",
 *     adminUrl: "http://localhost:9070",
 *   });
 *   const { sessionId } = await acp.startSession("claude-acp");
 *   await acp.sendPrompt(sessionId, "hello");
 *   const sessions = await acp.listSessions();
 */

import { createPubsubClient } from "@restatedev/pubsub-client";
import * as clients from "@restatedev/restate-sdk-clients";
import type * as restate from "@restatedev/restate-sdk";
import { AcpSession, type SessionState } from "./session.js";

export type { SessionState };

export interface AcpClientConfig {
  /** Restate ingress URL (e.g. http://localhost:18080). */
  ingressUrl: string;
  /** Restate admin URL (e.g. http://localhost:9070). */
  adminUrl: string;
  /** Optional bearer token for Restate calls. */
  apiKey?: string;
}

export interface SessionSummary {
  sessionId: string;
  agentName: string;
  status: string;
  startedAt: string;
  lastUpdatedAt: string;
}

// ─── Admin SQL helper ────────────────────────────────────────────────────────

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

// ─── External client (ingress + admin) ───────────────────────────────────────

export function createAcpClient(config: AcpClientConfig) {
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

  return {
    // ── Session lifecycle ─────────────────────────────────────────────────

    async startSession(agentName: string, cwd?: string) {
      const sessionId = crypto.randomUUID();
      const result = await ingress
        .objectClient(AcpSession, sessionId)
        .startSession({
          agentName,
          cwd: cwd ?? process.cwd(),
          mcpServers: [],
        });
      return { ...result, sessionId };
    },

    async sendPrompt(sessionId: string, text: string) {
      return ingress
        .objectClient(AcpSession, sessionId)
        .sendPrompt({
          sessionId,
          prompt: [{ type: "text", text }],
        });
    },

    async getStatus(sessionId: string) {
      return ingress
        .objectClient(AcpSession, sessionId)
        .getStatus();
    },

    async resume(sessionId: string, awakeableId: string, optionId: string) {
      return ingress
        .objectClient(AcpSession, sessionId)
        .resumeAgent({ awakeableId, optionId });
    },

    async terminate(sessionId: string) {
      return ingress
        .objectClient(AcpSession, sessionId)
        .terminateSession();
    },

    // ── Cross-session queries (admin SQL) ─────────────────────────────────

    async listSessions(): Promise<SessionSummary[]> {
      const rows = await queryAdmin(
        config.adminUrl,
        `SELECT service_key, value_utf8 FROM state WHERE service_name = 'AcpSession' AND key = 'meta'`,
        authHeaders,
      );

      const sessions: SessionSummary[] = [];
      for (const row of rows) {
        try {
          const meta = JSON.parse(row.value_utf8) as SessionState;
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

    // ── Streaming (pubsub) ────────────────────────────────────────────────

    subscribe(sessionId: string, opts?: { offset?: number; signal?: AbortSignal }) {
      return pubsub.pull({
        topic: `session:${sessionId}`,
        offset: opts?.offset ?? 0,
        signal: opts?.signal,
      });
    },

    subscribeSSE(sessionId: string, opts?: { offset?: number; signal?: AbortSignal }) {
      return pubsub.sse({
        topic: `session:${sessionId}`,
        offset: opts?.offset ?? 0,
        signal: opts?.signal,
      });
    },
  };
}

// ─── Restate context client (handler-to-handler) ─────────────────────────────

export function createAcpCtxClient(ctx: restate.Context) {
  return {
    async startSession(agentName: string, cwd?: string) {
      const sessionId = crypto.randomUUID();
      const result = await ctx
        .objectClient(AcpSession, sessionId)
        .startSession({
          agentName,
          cwd: cwd ?? process.cwd(),
          mcpServers: [],
        });
      return { ...result, sessionId };
    },

    async sendPrompt(sessionId: string, text: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .sendPrompt({
          sessionId,
          prompt: [{ type: "text", text }],
        });
    },

    async getStatus(sessionId: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .getStatus();
    },

    async resume(sessionId: string, awakeableId: string, optionId: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .resumeAgent({ awakeableId, optionId });
    },

    async terminate(sessionId: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .terminateSession();
    },
  };
}

export type AcpClient = ReturnType<typeof createAcpClient>;
export type AcpCtxClient = ReturnType<typeof createAcpCtxClient>;
