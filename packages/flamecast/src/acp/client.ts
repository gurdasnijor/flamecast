/**
 * Typed Restate client for the ACP Run VO.
 *
 *   const acp = createAcpClient({ restateUrl: "http://localhost:18080" });
 *   const result = await acp.prompt("claude-acp", "hello");
 *
 *   // Inside a Restate handler:
 *   const acp = createAcpCtxClient(ctx);
 *   const result = await acp.prompt("claude-acp", "hello");
 */

import * as clients from "@restatedev/restate-sdk-clients";
import type * as restate from "@restatedev/restate-sdk";
import { AcpRun, type RunState } from "./run-vo.js";
import { acpAgents } from "./agent-service.js";

export type { RunState };

// ─── External client (from outside Restate) ─────────────────────────────────

export function createAcpClient(opts: { restateUrl: string }) {
  const ingress = clients.connect({ url: opts.restateUrl });

  return {
    async prompt(agentName: string, text: string) {
      const runId = crypto.randomUUID();
      return ingress.objectClient(AcpRun, runId).execute({ agentName, prompt: text });
    },

    async runAsync(agentName: string, text: string) {
      const runId = crypto.randomUUID();
      await ingress.objectSendClient(AcpRun, runId).execute({ agentName, prompt: text });
      return { runId };
    },

    async getStatus(runId: string) {
      return ingress.objectClient(AcpRun, runId).getStatus();
    },

    async resume(runId: string, optionId: string) {
      return ingress.objectClient(AcpRun, runId).resume({ optionId });
    },

    async cancel(runId: string) {
      return ingress.objectClient(AcpRun, runId).cancel();
    },

    async agents() {
      return ingress.serviceClient(acpAgents).listAgents();
    },
  };
}

// ─── Context-aware client (from inside a Restate handler) ───────────────────

export function createAcpCtxClient(ctx: restate.Context) {
  return {
    async prompt(agentName: string, text: string) {
      const runId = crypto.randomUUID();
      return ctx.objectClient(AcpRun, runId).execute({ agentName, prompt: text });
    },

    async runAsync(agentName: string, text: string) {
      const runId = crypto.randomUUID();
      ctx.objectSendClient(AcpRun, runId).execute({ agentName, prompt: text });
      return { runId };
    },

    async getStatus(runId: string) {
      return ctx.objectClient(AcpRun, runId).getStatus();
    },

    async resume(runId: string, optionId: string) {
      return ctx.objectClient(AcpRun, runId).resume({ optionId });
    },

    async cancel(runId: string) {
      return ctx.objectClient(AcpRun, runId).cancel();
    },

    async agents() {
      return ctx.serviceClient(acpAgents).listAgents();
    },
  };
}

export type AcpClient = ReturnType<typeof createAcpClient>;
export type AcpCtxClient = ReturnType<typeof createAcpCtxClient>;
