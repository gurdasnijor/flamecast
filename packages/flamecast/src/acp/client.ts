/**
 * Typed Restate client for AcpSession.
 *
 *   const acp = createAcpClient({ restateUrl: "http://localhost:18080" });
 *   const { sessionId } = await acp.startSession("claude-acp");
 *   await acp.sendPrompt(sessionId, "hello");
 */

import * as clients from "@restatedev/restate-sdk-clients";
import type * as restate from "@restatedev/restate-sdk";
import { AcpSession, type SessionState } from "./session.js";
import { acpAgents } from "./agent-service.js";

export type { SessionState };

export function createAcpClient(opts: { restateUrl: string }) {
  const ingress = clients.connect({ url: opts.restateUrl });

  return {
    async startSession(agentName: string, cwd?: string) {
      const sessionId = crypto.randomUUID();
      const result = await ingress
        .objectClient(AcpSession, sessionId)
        .startSession({ agentName, cwd });
      return result;
    },

    async sendPrompt(sessionId: string, text: string) {
      return ingress
        .objectClient(AcpSession, sessionId)
        .sendPrompt({ text });
    },

    async getStatus(sessionId: string) {
      return ingress
        .objectClient(AcpSession, sessionId)
        .getStatus();
    },

    async resume(sessionId: string, awakeableId: string, optionId: string) {
      return ingress
        .objectClient(AcpSession, sessionId)
        .resumeAgent({ awakeableId, optionId });
    },

    async terminate(sessionId: string) {
      return ingress
        .objectClient(AcpSession, sessionId)
        .terminateSession();
    },

    async agents() {
      return ingress.serviceClient(acpAgents).listAgents();
    },
  };
}

export function createAcpCtxClient(ctx: restate.Context) {
  return {
    async startSession(agentName: string, cwd?: string) {
      const sessionId = crypto.randomUUID();
      return ctx
        .objectClient(AcpSession, sessionId)
        .startSession({ agentName, cwd });
    },

    async sendPrompt(sessionId: string, text: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .sendPrompt({ text });
    },

    async getStatus(sessionId: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .getStatus();
    },

    async resume(sessionId: string, awakeableId: string, optionId: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .resumeAgent({ awakeableId, optionId });
    },

    async terminate(sessionId: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .terminateSession();
    },

    async agents() {
      return ctx.serviceClient(acpAgents).listAgents();
    },
  };
}

export type AcpClient = ReturnType<typeof createAcpClient>;
export type AcpCtxClient = ReturnType<typeof createAcpCtxClient>;
