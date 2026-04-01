/**
 * A2AAdapter — HTTP adapter for Agent-to-Agent protocol.
 *
 * Wire protocol: A2A (JSON-RPC 2.0 over HTTP, SSE for streaming).
 * Replaces IbmAcpAdapter for all HTTP-based agents.
 *
 * Discovery: GET /.well-known/agent.json → AgentCard
 * Send:      POST / { jsonrpc: '2.0', method: 'message/send', params }
 * Stream:    POST / { jsonrpc: '2.0', method: 'message/stream', params }
 *
 * Task lifecycle: submitted → working → completed | failed | input-required
 *
 * Reference: docs/re-arch-unification.md Change 4
 */

import type { PromptResultPayload } from "@flamecast/protocol/session";
import type { AgentInfo, SessionHandle, AgentStartConfig, ConfigOption } from "./stdio.js";

// ─── A2A Types ────────────────────────────────────────────────────────────

export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  capabilities?: Record<string, unknown>;
}

export interface A2ATaskEvent {
  type: string;
  task?: {
    id: string;
    status?: { state: string; message?: string };
    artifacts?: Array<{ parts?: Array<{ text?: string; type?: string }> }>;
  };
}

// ─── Event Mapping ────────────────────────────────────────────────────────

/** Map A2A task events to the streaming event shape. Pure function. */
export function mapA2AEvent(event: A2ATaskEvent): {
  type: "text" | "complete" | "pause" | "error";
  [key: string]: unknown;
} | null {
  const task = event.task;
  if (!task) return null;

  const state = task.status?.state;

  // Artifact update → text content
  if (task.artifacts) {
    for (const artifact of task.artifacts) {
      if (artifact.parts) {
        for (const part of artifact.parts) {
          if (part.text) {
            return { type: "text", text: part.text, role: "assistant" };
          }
        }
      }
    }
  }

  // Status transitions
  if (state === "completed") {
    const output = task.artifacts?.flatMap((a) =>
      (a.parts ?? [])
        .filter((p) => p.text)
        .map((p) => ({
          role: "assistant" as const,
          parts: [{ contentType: "text/plain", content: p.text }],
        })),
    );
    return {
      type: "complete",
      result: { status: "completed", output, runId: task.id },
    };
  }

  if (state === "failed") {
    return {
      type: "error",
      code: "AGENT_FAILED",
      message: task.status?.message ?? "Agent failed",
    };
  }

  if (state === "input-required") {
    return { type: "pause", request: task.status?.message };
  }

  return null;
}

// ─── A2AAdapter ───────────────────────────────────────────────────────────

export class A2AAdapter {
  /** Discover agent via AgentCard and return session handle. */
  async start(config: AgentStartConfig): Promise<SessionHandle> {
    const baseUrl = config.agent;
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      throw new Error(`A2AAdapter requires an HTTP URL, got: ${baseUrl}`);
    }

    // Fetch agent card
    let card: AgentCard;
    try {
      const res = await fetch(
        `${baseUrl}/.well-known/agent.json`,
      );
      if (!res.ok) throw new Error(`${res.status}`);
      card = await res.json() as AgentCard;
    } catch {
      // Fallback if no agent card
      card = { name: baseUrl.split("/").pop() ?? "a2a-agent", url: baseUrl };
    }

    return {
      sessionId: config.sessionId ?? crypto.randomUUID(),
      protocol: "a2a",
      agent: {
        name: card.name,
        description: card.description,
        capabilities: card.capabilities,
      },
      connection: { url: baseUrl },
    };
  }

  /** Create a run — POST message/send, return task ID as runId. */
  async createRun(
    session: SessionHandle,
    text: string,
  ): Promise<{ runId: string }> {
    const url = session.connection.url!;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "message/send",
        params: {
          message: {
            role: "user",
            parts: [{ type: "text", text }],
          },
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`A2A message/send failed: ${res.status}`);
    }

    const body = (await res.json()) as {
      result?: { id?: string };
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(`A2A error: ${body.error.message}`);
    }

    const taskId = body.result?.id;
    if (!taskId) throw new Error("A2A response missing task ID");

    return { runId: taskId };
  }

  /** Cancel a running task. */
  async cancel(session: SessionHandle): Promise<void> {
    const url = session.connection.url;
    if (!url) return;
    // A2A cancel is best-effort
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tasks/cancel",
          params: { id: session.sessionId },
        }),
      });
    } catch {
      // best-effort
    }
  }

  /** No-op — A2A is stateless HTTP. */
  async close(_session: SessionHandle): Promise<void> {}

  async getConfigOptions(_session: SessionHandle): Promise<ConfigOption[]> {
    return [];
  }

  async setConfigOption(
    _session: SessionHandle,
    _configId: string,
    _value: string,
  ): Promise<ConfigOption[]> {
    return [];
  }
}
