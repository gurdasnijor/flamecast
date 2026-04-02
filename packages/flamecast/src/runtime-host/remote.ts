/**
 * RemoteRuntimeHost — HTTP client for a remote runtime-host sidecar.
 *
 * Delegates to a persistent HTTP server (Fly machine, ECS task, etc.)
 * via fetch(). Same RuntimeHost interface — no VO code changes needed.
 *
 * For deployed/multi-tenant environments where agent processes run on
 * separate infrastructure from the Restate endpoint.
 *
 * Reference: docs/re-arch-unification.md Change 3
 */

import type {
  AgentSpec,
  ProcessHandle,
  RuntimeHost,
  RuntimeHostCallbacks,
} from "./types.js";

export class RemoteRuntimeHost implements RuntimeHost {
  constructor(private baseUrl: string) {}

  async spawn(sessionId: string, spec: AgentSpec): Promise<ProcessHandle> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    if (!res.ok) {
      throw new Error(`Remote spawn failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as ProcessHandle;
  }

  async prompt(
    handle: ProcessHandle,
    text: string,
    callbacks: RuntimeHostCallbacks,
    awakeableId?: string,
  ): Promise<void> {
    // Non-blocking POST — the server drives the agent and resolves
    // the VO's awakeable on completion. Events stream to pubsub
    // via the server, not through this client.
    const res = await fetch(
      `${this.baseUrl}/sessions/${handle.sessionId}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, awakeableId }),
      },
    );
    if (!res.ok) {
      callbacks.onError(
        new Error(`Remote prompt failed: ${res.status} ${await res.text()}`),
      );
    }
    // 202 Accepted — server handles the rest asynchronously.
    // The VO suspends on an awakeable; the server resolves it.
  }

  async cancel(handle: ProcessHandle): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/sessions/${handle.sessionId}/cancel`,
      { method: "POST" },
    );
    if (!res.ok) {
      throw new Error(`Remote cancel failed: ${res.status}`);
    }
  }

  async close(handle: ProcessHandle): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/sessions/${handle.sessionId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      throw new Error(`Remote close failed: ${res.status}`);
    }
  }
}
