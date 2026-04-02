/**
 * Flamecast Client SDK — typed HTTP client for the ACP API.
 */

export type FlamecastClientOptions = {
  baseUrl: string | URL;
  fetch?: typeof fetch;
};

export interface AgentInfo {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionInfo {
  id: string;
  agentName: string;
  status: string;
  startedAt?: string;
  lastUpdatedAt?: string;
}

function normalizeBaseUrl(baseUrl: string | URL): string {
  const s = typeof baseUrl === "string" ? baseUrl : baseUrl.toString();
  return s.replace(/\/$/, "");
}

export function createFlamecastClient(opts: FlamecastClientOptions) {
  const client = new FlamecastClient(opts);
  return {
    fetchAgents: () => client.listAgents(),
    createSession: (body: { agentName: string; cwd?: string }) =>
      client.createSession(body),
    sendPrompt: (sessionId: string, text: string) =>
      client.sendPrompt(sessionId, text),
    fetchSession: (sessionId: string) => client.getSession(sessionId),
    cancelSession: (sessionId: string) => client.cancelSession(sessionId),
    resumeSession: (sessionId: string, awakeableId: string, optionId: string) =>
      client.resumeSession(sessionId, awakeableId, optionId),
    eventsUrl: (sessionId: string) => client.eventsUrl(sessionId),
    // Backwards compat
    fetchAgentTemplates: () => client.listAgents(),
    fetchSessions: () => Promise.resolve([]),
  };
}

export class FlamecastClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: FlamecastClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}/acp${path}`;
    return this.fetchFn(url, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  }

  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.request("/agents");
    return res.json();
  }

  async createSession(body: { agentName: string; cwd?: string }): Promise<SessionInfo> {
    const res = await this.request("/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    await this.request(`/sessions/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    const res = await this.request(`/sessions/${sessionId}`);
    return res.json();
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${sessionId}/cancel`, { method: "POST" });
  }

  async resumeSession(sessionId: string, awakeableId: string, optionId: string): Promise<void> {
    await this.request(`/sessions/${sessionId}/resume`, {
      method: "POST",
      body: JSON.stringify({ awakeableId, optionId }),
    });
  }

  async health(): Promise<{ status: string }> {
    const res = await this.request("/ping");
    return res.json();
  }

  eventsUrl(sessionId: string): string {
    return `${this.baseUrl}/acp/sessions/${sessionId}/events`;
  }
}
