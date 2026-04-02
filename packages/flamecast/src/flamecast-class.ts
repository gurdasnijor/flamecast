/**
 * Flamecast — agent orchestration SDK.
 *
 * Thin control plane:
 * - Agent template management (in-memory, passed at init)
 * - Hono app with API routes that delegate session ops to Restate VOs
 *
 * Session lifecycle, event streaming, permissions, and agent process
 * management are handled by AgentSession VO.
 */

import { Hono } from "hono";
import { serve as honoServe } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  RegisterAgentTemplateBody,
} from "@flamecast/protocol/session";
import { createApi } from "./api.js";

const randomUUID = (): string => crypto.randomUUID();

// ─── Public API types ───────────────────────────────────────────────────────

export type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  RegisterAgentTemplateBody,
} from "@flamecast/protocol/session";

// ─── Flamecast class ────────────────────────────────────────────────────────

export type FlamecastOptions = {
  agentTemplates?: AgentTemplate[];
  /** Restate ingress URL for VO calls (default: http://localhost:18080). */
  restateUrl?: string;
  /**
   * Custom fetch for environments where Restate isn't URL-addressable
   * (e.g. CF Container bindings via getContainer().fetch()).
   * When provided, all Restate SDK calls use this instead of globalThis.fetch.
   */
  fetch?: typeof globalThis.fetch;
};

export class Flamecast {
  private readonly templates: AgentTemplate[];
  readonly restateUrl: string;
  readonly customFetch?: typeof globalThis.fetch;

  /** The Hono app. Mount it on any runtime: Node, CF Workers, Vercel, etc. */
  readonly app: Hono;

  constructor(opts: FlamecastOptions = {}) {
    this.templates = opts.agentTemplates ? [...opts.agentTemplates] : [];
    this.restateUrl = opts.restateUrl ?? "http://localhost:18080";
    this.customFetch = opts.fetch;
    this.app = new Hono();
    this.app.route("/api", createApi(this));
  }

  /**
   * Start listening on the given port (Node.js only).
   */
  listen(
    port: number,
    callback?: (info: AddressInfo) => void,
  ): { close(): Promise<void> } {
    const server = honoServe({ fetch: this.app.fetch, port }, callback);
    return {
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  // ─── Agent Templates (in-memory) ───────────────────────────────────────

  listAgentTemplates(): AgentTemplate[] {
    return [...this.templates];
  }

  getAgentTemplate(id: string): AgentTemplate | undefined {
    return this.templates.find((t) => t.id === id);
  }

  registerAgentTemplate(body: RegisterAgentTemplateBody): AgentTemplate {
    const template: AgentTemplate = {
      id: randomUUID(),
      name: body.name,
      spawn: {
        command: body.spawn.command,
        args: [...body.spawn.args],
      },
      runtime: body.runtime ?? { provider: "local" },
      ...(body.env ? { env: body.env } : {}),
    };

    this.templates.push(template);
    return template;
  }

  updateAgentTemplate(
    id: string,
    patch: {
      name?: string;
      spawn?: AgentTemplate["spawn"];
      runtime?: Partial<AgentTemplate["runtime"]>;
      env?: Record<string, string>;
    },
  ): AgentTemplate {
    const idx = this.templates.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Agent template "${id}" not found`);

    const existing = this.templates[idx];
    const updated: AgentTemplate = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.spawn ? { spawn: patch.spawn } : {}),
      ...(patch.runtime ? { runtime: { ...existing.runtime, ...patch.runtime } } : {}),
      ...(patch.env !== undefined ? { env: patch.env } : {}),
    };

    this.templates[idx] = updated;
    return updated;
  }

  resolveSessionConfig(opts: {
    agentTemplateId?: string;
    spawn?: AgentSpawn;
    name?: string;
  }): {
    agentName: string;
    spawn: AgentSpawn;
    runtime: AgentTemplateRuntime;
  } {
    if (opts.agentTemplateId) {
      const template = this.getAgentTemplate(opts.agentTemplateId);
      if (!template) {
        throw new Error(`Unknown agent template "${opts.agentTemplateId}"`);
      }

      const mergedEnv =
        template.runtime?.env || template.env
          ? { ...template.runtime?.env, ...template.env }
          : undefined;

      return {
        agentName: template.name,
        spawn: { command: template.spawn.command, args: [...template.spawn.args] },
        runtime: { ...template.runtime, ...(mergedEnv ? { env: mergedEnv } : {}) },
      };
    }

    if (!opts.spawn) {
      throw new Error("Provide agentTemplateId or spawn");
    }

    return {
      agentName:
        opts.name?.trim() ||
        [opts.spawn.command, ...(opts.spawn.args ?? [])].filter(Boolean).join(" "),
      spawn: { command: opts.spawn.command, args: [...(opts.spawn.args ?? [])] },
      runtime: { provider: "local" },
    };
  }
}
