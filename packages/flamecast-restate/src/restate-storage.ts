import type {
  FlamecastStorage,
  SessionMeta,
  SessionRuntimeInfo,
  StoredSession,
} from "@flamecast/sdk";
import type { AgentTemplate, WebhookConfig } from "@flamecast/protocol/session";
import type { RuntimeInstance } from "@flamecast/protocol/runtime";
import type { SessionMeta as VOSessionMeta } from "./session-object.js";

/**
 * RestateStorage — FlamecastStorage backed by Restate's SQL introspection API.
 *
 * Session methods read from Restate's state table via `POST {adminUrl}/query`.
 * Non-session methods (templates, runtime instances) delegate to an inner
 * Postgres-backed storage.
 *
 * This eliminates the "Session not found" bug where RestateSessionService
 * creates sessions in Restate VO state but snapshotSession reads from Postgres.
 */
export class RestateStorage implements FlamecastStorage {
  constructor(
    private readonly adminUrl: string,
    private readonly inner: FlamecastStorage,
  ) {}

  // ---------------------------------------------------------------------------
  // Restate SQL query helper
  // ---------------------------------------------------------------------------

  private async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    const resp = await fetch(`${this.adminUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!resp.ok) {
      throw new Error(
        `Restate query failed (${resp.status}): ${await resp.text()}`,
      );
    }
    const json = await resp.json();
    // Restate returns { rows: [{col: val, ...}, ...] } with named columns
    return json as { rows: Record<string, unknown>[] };
  }

  // ---------------------------------------------------------------------------
  // Mapping: Restate VO SessionMeta → FlamecastStorage SessionMeta
  // ---------------------------------------------------------------------------

  private voMetaToSessionMeta(vo: VOSessionMeta): SessionMeta {
    return {
      id: vo.id,
      agentName: vo.agentName,
      spawn: vo.spawn,
      startedAt: vo.startedAt,
      lastUpdatedAt: vo.lastUpdatedAt,
      status: vo.status,
      pendingPermission: (vo.pendingPermission as SessionMeta["pendingPermission"]) ?? null,
      websocketUrl: vo.websocketUrl,
      runtime: vo.runtimeName,
    };
  }

  private voMetaToRuntimeInfo(vo: VOSessionMeta): SessionRuntimeInfo {
    return {
      hostUrl: vo.hostUrl,
      websocketUrl: vo.websocketUrl,
      runtimeName: vo.runtimeName,
    };
  }

  // ---------------------------------------------------------------------------
  // Session methods → Restate SQL API
  // ---------------------------------------------------------------------------

  async getSessionMeta(id: string): Promise<SessionMeta | null> {
    const { rows } = await this.query(
      `SELECT value_utf8 FROM state ` +
        `WHERE service_name = 'FlamecastSession' ` +
        `AND service_key = '${id}' AND key = 'meta'`,
    );
    if (rows.length === 0) return null;
    const raw = rows[0].value_utf8 as string | undefined;
    if (!raw) return null;
    const vo: VOSessionMeta = JSON.parse(raw);
    return this.voMetaToSessionMeta(vo);
  }

  async getStoredSession(id: string): Promise<StoredSession | null> {
    const { rows } = await this.query(
      `SELECT key, value_utf8 FROM state ` +
        `WHERE service_name = 'FlamecastSession' ` +
        `AND service_key = '${id}' AND key IN ('meta', 'webhooks')`,
    );
    if (rows.length === 0) return null;

    let vo: VOSessionMeta | null = null;
    let webhooks: WebhookConfig[] = [];

    for (const row of rows) {
      const stateKey = row.key as string;
      const raw = row.value_utf8 as string | undefined;
      if (!raw) continue;
      const value = JSON.parse(raw);
      if (stateKey === "meta") vo = value;
      if (stateKey === "webhooks") webhooks = value;
    }

    if (!vo) return null;

    return {
      meta: this.voMetaToSessionMeta(vo),
      runtimeInfo: this.voMetaToRuntimeInfo(vo),
      webhooks,
    };
  }

  async listAllSessions(): Promise<SessionMeta[]> {
    const { rows } = await this.query(
      `SELECT value_utf8 FROM state ` +
        `WHERE service_name = 'FlamecastSession' AND key = 'meta'`,
    );
    return rows
      .filter((row) => row.value_utf8)
      .map((row) => {
        const vo: VOSessionMeta = JSON.parse(row.value_utf8 as string);
        return this.voMetaToSessionMeta(vo);
      });
  }

  async listActiveSessionsWithRuntime(): Promise<StoredSession[]> {
    const { rows } = await this.query(
      `SELECT service_key, key, value_utf8 FROM state ` +
        `WHERE service_name = 'FlamecastSession' AND key IN ('meta', 'webhooks')`,
    );

    // Group by session key
    const sessions = new Map<
      string,
      { meta?: VOSessionMeta; webhooks?: WebhookConfig[] }
    >();
    for (const row of rows) {
      const sessionKey = row.service_key as string;
      const stateKey = row.key as string;
      const raw = row.value_utf8 as string | undefined;
      if (!raw) continue;
      const value = JSON.parse(raw);
      if (!sessions.has(sessionKey)) sessions.set(sessionKey, {});
      const entry = sessions.get(sessionKey)!;
      if (stateKey === "meta") entry.meta = value;
      if (stateKey === "webhooks") entry.webhooks = value;
    }

    // Filter to active and build StoredSessions
    const result: StoredSession[] = [];
    for (const entry of sessions.values()) {
      if (!entry.meta || entry.meta.status !== "active") continue;
      result.push({
        meta: this.voMetaToSessionMeta(entry.meta),
        runtimeInfo: this.voMetaToRuntimeInfo(entry.meta),
        webhooks: entry.webhooks ?? [],
      });
    }
    return result;
  }

  async createSession(
    _meta: SessionMeta,
    _runtimeInfo?: SessionRuntimeInfo,
    _webhooks?: WebhookConfig[],
  ): Promise<void> {
    // No-op — the VO start handler writes state
  }

  async updateSession(
    _id: string,
    _patch: Partial<Pick<SessionMeta, "lastUpdatedAt" | "pendingPermission">>,
  ): Promise<void> {
    // No-op — the VO handleCallback handler updates state
  }

  async finalizeSession(
    _id: string,
    _reason: "terminated",
  ): Promise<void> {
    // No-op — the VO terminate handler updates status
  }

  // ---------------------------------------------------------------------------
  // Template methods → Postgres passthrough
  // ---------------------------------------------------------------------------

  seedAgentTemplates(templates: AgentTemplate[]): Promise<void> {
    return this.inner.seedAgentTemplates(templates);
  }

  listAgentTemplates(): Promise<AgentTemplate[]> {
    return this.inner.listAgentTemplates();
  }

  getAgentTemplate(id: string): Promise<AgentTemplate | null> {
    return this.inner.getAgentTemplate(id);
  }

  saveAgentTemplate(template: AgentTemplate): Promise<void> {
    return this.inner.saveAgentTemplate(template);
  }

  updateAgentTemplate(
    id: string,
    patch: {
      name?: string;
      spawn?: AgentTemplate["spawn"];
      runtime?: Partial<AgentTemplate["runtime"]>;
      env?: Record<string, string>;
    },
  ): Promise<AgentTemplate | null> {
    return this.inner.updateAgentTemplate(id, patch);
  }

  // ---------------------------------------------------------------------------
  // Runtime instance methods → Postgres passthrough
  // ---------------------------------------------------------------------------

  saveRuntimeInstance(instance: RuntimeInstance): Promise<void> {
    return this.inner.saveRuntimeInstance(instance);
  }

  listRuntimeInstances(): Promise<RuntimeInstance[]> {
    return this.inner.listRuntimeInstances();
  }

  deleteRuntimeInstance(name: string): Promise<void> {
    return this.inner.deleteRuntimeInstance(name);
  }
}
