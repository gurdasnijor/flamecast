/**
 * FlamecastClient — ACP Agent interface over Restate.
 *
 * Implements the same Agent interface as ClientSideConnection,
 * but uses Restate ingress as the transport instead of a raw stream.
 * Session updates arrive via pubsub SSE and route to the caller's
 * acp.Client callbacks.
 *
 * From the consumer's perspective, this is a drop-in replacement
 * for ClientSideConnection:
 *
 *   // Direct agent (raw stream)
 *   const conn = new ClientSideConnection((agent) => myClient, stream);
 *
 *   // Through Restate (durable)
 *   const conn = new FlamecastClient({ ingressUrl, onSessionUpdate });
 *
 * Both implement Agent: initialize, newSession, prompt, cancel.
 *
 * Reference: https://agentclientprotocol.com/protocol/schema
 */

import * as restate from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";
import * as acp from "@agentclientprotocol/sdk";

// Type-only — no server SDK in bundle
import type { AcpSession as AcpSessionDef } from "../session.js";
const AcpSession: typeof AcpSessionDef = { name: "AcpSession" } as never;

export interface AgentInfo {
  name: string;
  description?: string;
}

export interface FlamecastClientConfig {
  /** Restate ingress URL. */
  ingressUrl: string;
  /** Optional bearer token. */
  apiKey?: string;
  /** Called when the agent sends session update notifications. */
  onSessionUpdate?: (params: acp.SessionNotification) => void;
  /** Called when the agent requests permission. Auto-approves if not provided. */
  onPermissionRequest?: (
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
}

export class FlamecastClient implements acp.Agent {
  private ingress: ReturnType<typeof restate.connect>;
  private pubsub: ReturnType<typeof createPubsubClient>;
  private config: FlamecastClientConfig;
  private sessionId: string | null = null;
  private sseAbort: AbortController | null = null;

  constructor(config: FlamecastClientConfig) {
    this.config = config;
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
      pullInterval: { milliseconds: 300 },
    });
  }

  // ── Agent interface ───────────────────────────────────────────────────

  async initialize(
    params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    // Pool is pre-warmed — agent capabilities come from the VO's stored
    // init response. For now, return a compatible response.
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const agentName =
      (params._meta?.agentName as string) ?? "claude-acp";

    await this.ingress
      .objectClient(AcpSession, sessionId)
      .newSession({
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        _meta: { agentName },
      });

    this.sessionId = sessionId;

    // Start listening for session events via pubsub SSE
    this.startEventListener(sessionId);

    return { sessionId };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const result = await this.ingress
      .objectClient(AcpSession, params.sessionId)
      .prompt(params);

    return result as acp.PromptResponse;
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    await this.ingress
      .objectClient(AcpSession, params.sessionId)
      .cancel();
  }

  async authenticate(
    _params: acp.AuthenticateRequest,
  ): Promise<void> {
    // Not implemented — no auth required for local Restate
  }

  // ── Session management (not part of core Agent, but useful) ───────────

  async closeSession(params: {
    sessionId: string;
  }): Promise<acp.PromptResponse> {
    const result = await this.ingress
      .objectClient(AcpSession, params.sessionId)
      .close();

    this.stopEventListener();
    return result as acp.PromptResponse;
  }

  async getStatus(sessionId: string) {
    return this.ingress
      .objectClient(AcpSession, sessionId)
      .getStatus();
  }

  async resumePermission(
    sessionId: string,
    awakeableId: string,
    optionId: string,
    outcome: "selected" | "cancelled" = "selected",
  ) {
    return this.ingress
      .objectClient(AcpSession, sessionId)
      .resumePermission({ awakeableId, optionId, outcome });
  }

  // ── Agent discovery ──────────────────────────────────────────────────

  async listAgents(): Promise<AgentInfo[]> {
    return this.ingress
      .objectClient(AcpSession, "_discovery")
      .listAgents() as Promise<AgentInfo[]>;
  }

  // ── Streaming ───────────────────────────────────────────────────────

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

  // ── Event listener (pubsub SSE → acp.Client callbacks) ───────────────

  private startEventListener(sessionId: string) {
    this.stopEventListener();

    const ac = new AbortController();
    this.sseAbort = ac;

    const stream = this.pubsub.sse({
      topic: `session:${sessionId}`,
      offset: 0,
      signal: ac.signal,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value as Uint8Array, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6)) as Record<
                  string,
                  unknown
                >;
                this.handleEvent(event);
              } catch {
                // skip malformed
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("[FlamecastClient] SSE error:", err);
        }
      }
    })();
  }

  private stopEventListener() {
    this.sseAbort?.abort();
    this.sseAbort = null;
  }

  private handleEvent(event: Record<string, unknown>) {
    const type = event.type as string;

    if (type === "session_update" && this.config.onSessionUpdate) {
      this.config.onSessionUpdate({
        sessionId: this.sessionId ?? "",
        update: event.update as acp.SessionNotification["update"],
      });
    }

    if (type === "permission_request" && this.sessionId) {
      const awakeableId = event.awakeableId as string;
      const permRequest = {
        sessionId: this.sessionId,
        toolCall: event.toolCall as acp.RequestPermissionRequest["toolCall"],
        options: event.options as acp.RequestPermissionRequest["options"],
      };

      if (this.config.onPermissionRequest) {
        this.config.onPermissionRequest(permRequest).then((response) => {
          const optionId =
            response.outcome.outcome === "selected"
              ? response.outcome.optionId
              : undefined;
          this.resumePermission(
            this.sessionId!,
            awakeableId,
            optionId ?? "",
            response.outcome.outcome === "cancelled"
              ? "cancelled"
              : "selected",
          ).catch((err) =>
            console.error("[FlamecastClient] resume error:", err),
          );
        });
      } else {
        // Auto-approve first option
        const options = event.options as Array<{ optionId: string }>;
        if (options?.[0]) {
          this.resumePermission(
            this.sessionId,
            awakeableId,
            options[0].optionId,
          ).catch((err) =>
            console.error("[FlamecastClient] auto-approve error:", err),
          );
        }
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  dispose() {
    this.stopEventListener();
  }
}
