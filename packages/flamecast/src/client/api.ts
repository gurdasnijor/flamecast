/**
 * Flamecast Client SDK — typed HTTP client for the Flamecast API.
 */

import type { AgentTemplate, RegisterAgentTemplateBody } from "@flamecast/protocol/session";

export type FlamecastClientOptions = {
  baseUrl: string | URL;
  fetch?: typeof fetch;
};

function normalizeBaseUrl(baseUrl: string | URL): string {
  return typeof baseUrl === "string" ? baseUrl : baseUrl.toString();
}

export function createFlamecastClient(opts: FlamecastClientOptions) {
  const client = new FlamecastClient(opts);
  return {
    fetchAgentTemplates: () => client.listAgentTemplates(),
    registerAgentTemplate: (body: RegisterAgentTemplateBody) => client.registerAgentTemplate(body),
    updateAgentTemplate: (id: string, patch: Partial<AgentTemplate>) =>
      client.updateAgentTemplate(id, patch),
    createSession: (body: { agentTemplateId: string; cwd?: string }) =>
      client.createSession(body),
    fetchSession: (id: string) => client.fetchSession(id),
    fetchSessions: () => client.listSessions(),
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
    const url = `${this.baseUrl}/api${path}`;
    return this.fetchFn(url, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  }

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    const res = await this.request("/agent-templates");
    return res.json();
  }

  async registerAgentTemplate(body: RegisterAgentTemplateBody): Promise<AgentTemplate> {
    const res = await this.request("/agent-templates", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async updateAgentTemplate(
    id: string,
    patch: Partial<AgentTemplate>,
  ): Promise<AgentTemplate> {
    const res = await this.request(`/agent-templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    return res.json();
  }

  async createSession(body: {
    agentTemplateId: string;
    cwd?: string;
  }): Promise<{ id: string }> {
    const res = await this.request("/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async listSessions(): Promise<Record<string, unknown>[]> {
    const res = await this.request("/sessions");
    return res.json();
  }

  async fetchSession(id: string): Promise<Record<string, unknown>> {
    const res = await this.request(`/sessions/${id}`);
    return res.json();
  }

  async health(): Promise<{ status: string }> {
    const res = await this.request("/health");
    return res.json();
  }
}
