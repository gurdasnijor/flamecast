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

export interface RunResult {
  id: string;
  agentName: string;
  status: string;
  input?: string;
  output?: string;
  error?: string;
  createdAt?: string;
  completedAt?: string;
  awaitRequest?: unknown;
}

function normalizeBaseUrl(baseUrl: string | URL): string {
  const s = typeof baseUrl === "string" ? baseUrl : baseUrl.toString();
  return s.replace(/\/$/, "");
}

export function createFlamecastClient(opts: FlamecastClientOptions) {
  const client = new FlamecastClient(opts);
  return {
    fetchAgents: () => client.listAgents(),
    createRun: (body: { agentName: string; prompt: string }) =>
      client.createRun(body),
    fetchRun: (id: string) => client.getRun(id),
    resumeRun: (id: string, optionId: string) =>
      client.resumeRun(id, optionId),
    cancelRun: (id: string) => client.cancelRun(id),
    // Backwards compat aliases
    fetchAgentTemplates: () => client.listAgents(),
    createSession: (body: { agentTemplateId: string }) =>
      client.createRun({ agentName: body.agentTemplateId, prompt: "" }),
    fetchSessions: () => Promise.resolve([]),
    fetchSession: (id: string) => client.getRun(id),
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

  async createRun(body: {
    agentName: string;
    prompt: string;
    mode?: "sync" | "async";
  }): Promise<RunResult> {
    const res = await this.request("/runs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async getRun(id: string): Promise<RunResult> {
    const res = await this.request(`/runs/${id}`);
    return res.json();
  }

  async resumeRun(id: string, optionId: string): Promise<RunResult> {
    const res = await this.request(`/runs/${id}`, {
      method: "POST",
      body: JSON.stringify({ optionId }),
    });
    return res.json();
  }

  async cancelRun(id: string): Promise<RunResult> {
    const res = await this.request(`/runs/${id}/cancel`, {
      method: "POST",
    });
    return res.json();
  }

  async health(): Promise<{ status: string }> {
    const res = await this.request("/ping");
    return res.json();
  }

  eventsUrl(runId: string): string {
    return `${this.baseUrl}/acp/runs/${runId}/events`;
  }
}
