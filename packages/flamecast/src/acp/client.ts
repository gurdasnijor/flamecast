/**
 * Restate context client for handler-to-handler AcpSession calls.
 *
 * Uses ctx.objectClient() for durable, journaled calls within Restate.
 * For external callers (browser, server), use @flamecast/client instead.
 */

import type * as restate from "@restatedev/restate-sdk";
import { AcpSession, type SessionState } from "./session.js";

export type { SessionState };

export function createAcpCtxClient(ctx: restate.Context) {
  return {
    async startSession(agentName: string, cwd?: string) {
      const sessionId = crypto.randomUUID();
      const result = await ctx
        .objectClient(AcpSession, sessionId)
        .startSession({
          agentName,
          cwd: cwd ?? process.cwd(),
          mcpServers: [],
        });
      return { ...result, sessionId };
    },

    async sendPrompt(sessionId: string, text: string) {
      return ctx
        .objectClient(AcpSession, sessionId)
        .sendPrompt({
          sessionId,
          prompt: [{ type: "text", text }],
        });
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
  };
}

export type AcpCtxClient = ReturnType<typeof createAcpCtxClient>;
