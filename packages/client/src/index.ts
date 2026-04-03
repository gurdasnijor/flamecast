/**
 * @flamecast/client — browser-safe typed client for AcpSession.
 *
 * Uses @restatedev/restate-sdk-clients (pure fetch, no Node deps)
 * and types from @agentclientprotocol/sdk.
 *
 * Does NOT import the server SDK or the VO definition — safe for
 * browser bundles.
 *
 *   import { createFlamecastClient } from "@flamecast/client";
 *
 *   const client = createFlamecastClient({
 *     ingressUrl: "http://localhost:18080",
 *   });
 *   const { sessionId } = await client.startSession("claude-acp");
 *   await client.sendPrompt(sessionId, "hello");
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

/** ACP run status — matches the protocol lifecycle. */
export type RunStatus =
  | "created"
  | "in-progress"
  | "awaiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed";

/** Session status returned by getStatus. */
export interface SessionStatus {
  sessionId: string;
  agentName: string;
  status: RunStatus;
  startedAt: string;
  lastUpdatedAt: string;
}

/** Agent info returned by listAgents. */
export interface AgentInfo {
  name: string;
  description?: string;
}

export interface FlamecastClientConfig {
  /** Restate ingress URL. */
  ingressUrl: string;
  /** Optional bearer token. */
  apiKey?: string;
}

// Re-export ACP types that callers may need
export type { NewSessionResponse, PromptRequest, PromptResponse, RequestPermissionResponse };

// ─── Service/VO references (no server SDK import) ───────────────────────────

const AcpSessionRef = { name: "AcpSession" } as Parameters<
  ReturnType<typeof clients.connect>["objectClient"]
>[0];

const AcpAgentsRef = { name: "AcpAgents" } as Parameters<
  ReturnType<typeof clients.connect>["serviceClient"]
>[0];

// ─── Client ─────────────────────────────────────────────────────────────────

export function createFlamecastClient(config: FlamecastClientConfig) {
  const authHeaders = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : undefined;

  const ingress = clients.connect({
    url: config.ingressUrl,
    headers: authHeaders,
  });

  const pubsub = createPubsubClient({
    name: "pubsub",
    ingressUrl: config.ingressUrl,
    headers: authHeaders,
    pullInterval: { milliseconds: 500 },
  });

  // Typed wrappers — we cast the untyped objectClient to get proper signatures
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

    async listAgents() {
      return agentsClient().listAgents();
    },

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
  };
}

export type FlamecastClient = ReturnType<typeof createFlamecastClient>;
