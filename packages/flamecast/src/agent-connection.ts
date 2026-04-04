/**
 * AgentConnection — Restate Virtual Object, keyed by clientId.
 *
 * Connection-level ACP Agent handlers: initialize, authenticate, newSession, listSessions.
 * Maintains session index in K/V state.
 *
 * Type-checked against acp.Agent via RestateAgentConnection mapped type.
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import { AgentSession } from "./agent-session.js";

// ─── Type safety: VO handlers must match acp.Agent ──────────────────────

/** Connection-scoped subset of acp.Agent, lifted for Restate (ctx as first arg). */
type RestateAgentConnection = {
  [K in "initialize" | "authenticate" | "newSession" | "listSessions"]: Required<acp.Agent>[K] extends (...args: infer A) => infer R
    ? (ctx: restate.ObjectContext, ...args: A) => R
    : never;
};

// ─── State ──────────────────────────────────────────────────────────────

interface ConnectionState {
  capabilities: acp.InitializeResponse;
  sessions: Array<{ sessionId: string; cwd: string; createdAt: string }>;
}

// ─── Virtual Object ─────────────────────────────────────────────────────

export const AgentConnection = restate.object<string, RestateAgentConnection>({
  name: "AgentConnection",
  handlers: {
    async initialize(ctx: restate.ObjectContext, _params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
      const response: acp.InitializeResponse = {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
        },
      };
      ctx.set("capabilities", response);
      ctx.set("sessions", []);
      return response;
    },

    async authenticate(_ctx: restate.ObjectContext, _params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse | void> {
      return {};
    },

    async newSession(ctx: restate.ObjectContext, params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
      const sessionId = ctx.rand.uuidv4();
      const spawnConfig = params._meta?.spawnConfig as Record<string, unknown> | undefined;
      const agentName = (params._meta?.agentName as string) ?? "claude-acp";

      // Initialize the session VO
      await ctx.objectClient(AgentSession, sessionId).init({
        clientId: ctx.key,
        agentName,
        spawnConfig: spawnConfig ?? null,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
      });

      // Add to session index
      const sessions = (await ctx.get<ConnectionState["sessions"]>("sessions")) ?? [];
      sessions.push({ sessionId, cwd: params.cwd, createdAt: await ctx.date.toJSON() });
      ctx.set("sessions", sessions);

      return { sessionId };
    },

    async listSessions(ctx: restate.ObjectContext, _params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
      const sessions = (await ctx.get<ConnectionState["sessions"]>("sessions")) ?? [];
      return {
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
        })),
      };
    },
  },
});
