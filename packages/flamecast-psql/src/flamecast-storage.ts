import type { RuntimeInstance } from "@flamecast/protocol/runtime";
import type { AgentTemplate, Session, WebhookConfig } from "@flamecast/protocol/session";

/** Durable slice of {@link Session} (everything except runtime-only state). */
export type SessionMeta = Omit<Session, "fileSystem" | "logs" | "promptQueue">;

/** Runtime connection info persisted alongside a session for recovery after restart. */
export interface SessionRuntimeInfo {
  hostUrl: string;
  websocketUrl: string;
  runtimeName: string;
  runtimeMeta?: Record<string, unknown> | null;
}

/** Storage view of a session, including durable routing metadata. */
export interface StoredSession {
  meta: SessionMeta;
  runtimeInfo: SessionRuntimeInfo | null;
  webhooks: WebhookConfig[];
}

/** Drizzle-backed Flamecast storage surface. */
export interface PsqlFlamecastStorage {
  seedAgentTemplates(templates: AgentTemplate[]): Promise<void>;
  listAgentTemplates(): Promise<AgentTemplate[]>;
  getAgentTemplate(id: string): Promise<AgentTemplate | null>;
  saveAgentTemplate(template: AgentTemplate): Promise<void>;
  updateAgentTemplate(
    id: string,
    patch: {
      name?: string;
      spawn?: AgentTemplate["spawn"];
      runtime?: Partial<AgentTemplate["runtime"]>;
      env?: Record<string, string>;
    },
  ): Promise<AgentTemplate | null>;
  createSession(
    meta: SessionMeta,
    runtimeInfo?: SessionRuntimeInfo,
    webhooks?: WebhookConfig[],
  ): Promise<void>;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionMeta, "lastUpdatedAt" | "pendingPermission">>,
  ): Promise<void>;
  getSessionMeta(id: string): Promise<SessionMeta | null>;
  getStoredSession(id: string): Promise<StoredSession | null>;
  listAllSessions(): Promise<SessionMeta[]>;
  listActiveSessionsWithRuntime(): Promise<StoredSession[]>;
  finalizeSession(id: string, reason: "terminated"): Promise<void>;
  saveRuntimeInstance(instance: RuntimeInstance): Promise<void>;
  listRuntimeInstances(): Promise<RuntimeInstance[]>;
  deleteRuntimeInstance(name: string): Promise<void>;
}
