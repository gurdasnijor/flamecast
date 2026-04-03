/**
 * AcpSession — Restate Virtual Object for multi-turn agent sessions.
 *
 * VO state IS the agent handle:
 *   agentName, acpSessionId, agentCapabilities, history, meta
 *
 * Each handler connects fresh using stored state. No module-level cache.
 * For remote agents this is cheap (HTTP round-trip). For stdio the process
 * spawns per handler — optimization via process cache is a separate concern.
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import {
  zNewSessionRequest,
  zNewSessionResponse,
  zPromptRequest,
  zPromptResponse,
  zRequestPermissionResponse,
  zSessionInfo,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createPubsubClient } from "@restatedev/pubsub-client";
import {
  loadRegistryFromIds,
  type AgentManifest,
} from "@flamecast/acp/registry";

// ─── Configuration ─────────────────────────────────────────────────────────

export interface AcpConfig {
  resolveAgent: (
    agentName: string,
    clientFactory: (agent: acp.Agent) => acp.Client,
  ) => Promise<acp.ClientSideConnection> | acp.ClientSideConnection;
}

let resolve: AcpConfig["resolveAgent"] | null = null;

let pubsub = createPubsubClient({
  name: "pubsub",
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

export function configureAcp(
  config: AcpConfig,
  opts?: { ingressUrl?: string },
) {
  resolve = config.resolveAgent;
  if (opts?.ingressUrl) {
    pubsub = createPubsubClient({
      name: "pubsub",
      ingressUrl: opts.ingressUrl,
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emit(ctx: restate.ObjectContext, event: Record<string, unknown>) {
  pubsub.publish(`session:${ctx.key}`, event, ctx.rand.uuidv4());
}

/** Connect to the downstream agent, bound to the current handler's ctx. */
async function connectAgent(
  ctx: restate.ObjectContext,
): Promise<acp.ClientSideConnection> {
  if (!resolve) throw new Error("configureAcp() not called");
  const agentName = (await ctx.get<string>("agentName"))!;
  return resolve(agentName, () => createClient(ctx));
}

/** Create an acp.Client bound to the current Restate handler context. */
function createClient(ctx: restate.ObjectContext): acp.Client {
  return {
    async sessionUpdate(params: acp.SessionNotification) {
      emit(ctx, {
        type: "session_update",
        sessionUpdate: params.update.sessionUpdate,
        update: params.update,
      });
    },
    async requestPermission(params: acp.RequestPermissionRequest) {
      const { id: awakeableId, promise } =
        ctx.awakeable<acp.RequestPermissionOutcome>();
      emit(ctx, {
        type: "permission_request",
        toolCall: params.toolCall,
        options: params.options,
        awakeableId,
      });
      return { outcome: await promise };
    },
    async readTextFile(params: acp.ReadTextFileRequest) {
      return { content: await readFile(params.path, "utf-8") };
    },
    async writeTextFile(params: acp.WriteTextFileRequest) {
      await mkdir(dirname(params.path), { recursive: true });
      await writeFile(params.path, params.content, "utf-8");
      return {};
    },
  };
}

/**
 * Reconnect to an agent and restore the ACP session.
 * Uses stored acpSessionId — loadSession if supported, otherwise replay.
 */
async function reconnectAgent(
  ctx: restate.ObjectContext,
): Promise<acp.ClientSideConnection> {
  const agent = await connectAgent(ctx);
  const acpSessionId = (await ctx.get<string>("acpSessionId"))!;

  await agent.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "flamecast", title: "Flamecast", version: "0.1.0" },
  });

  const caps = await ctx.get<acp.AgentCapabilities>("agentCapabilities");
  const cwd = (await ctx.get<SessionState>("meta"))?.cwd ?? process.cwd();

  if (caps?.loadSession) {
    await agent.loadSession({ sessionId: acpSessionId, cwd, mcpServers: [] });
  } else {
    const session = await agent.newSession({ cwd, mcpServers: [] });
    ctx.set("acpSessionId", session.sessionId);

    const history =
      (await ctx.get<Array<{ role: string; prompt?: acp.PromptRequest["prompt"] }>>(
        "history",
      )) ?? [];
    for (const turn of history) {
      if (turn.role === "user" && turn.prompt) {
        await agent.prompt({ sessionId: session.sessionId, prompt: turn.prompt });
      }
    }
  }

  return agent;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

const ResumePermissionInput = z.object({
  awakeableId: z.string(),
  optionId: z.string().optional(),
  outcome: z.enum(["selected", "cancelled"]).default("selected"),
});

export type SessionState = acp.SessionInfo;

// ─── Virtual Object ────────────────────────────────────────────────────────

export const AcpSession = restate.object({
  name: "AcpSession",
  handlers: {
    newSession: restate.handlers.object.exclusive(
      {
        input: restate.serde.schema(zNewSessionRequest),
        output: restate.serde.schema(zNewSessionResponse),
      },
      async (
        ctx: restate.ObjectContext,
        input: acp.NewSessionRequest,
      ): Promise<acp.NewSessionResponse> => {
        const sessionId = ctx.key;
        const agentName = (input._meta?.agentName as string) ?? "claude-acp";
        ctx.set("agentName", agentName);

        // Journal the init so acpSessionId is deterministic on replay.
        const { acpSessionId, agentCapabilities } = await ctx.run(
          "agent_init",
          async () => {
            const agent = await connectAgent(ctx);

            const initResponse = await agent.initialize({
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
              },
              clientInfo: {
                name: "flamecast",
                title: "Flamecast",
                version: "0.1.0",
              },
            });

            const session = await agent.newSession({
              cwd: input.cwd,
              mcpServers: input.mcpServers,
            });

            return {
              acpSessionId: session.sessionId,
              agentCapabilities: initResponse.agentCapabilities,
            };
          },
        );

        ctx.set("meta", { sessionId, cwd: input.cwd } satisfies SessionState);
        ctx.set("acpSessionId", acpSessionId);
        ctx.set("agentCapabilities", agentCapabilities);
        ctx.set("history", []);

        emit(ctx, { type: "session.created", sessionId });
        return { sessionId };
      },
    ),

    prompt: restate.handlers.object.exclusive(
      {
        input: restate.serde.schema(zPromptRequest),
        output: restate.serde.schema(zPromptResponse),
      },
      async (
        ctx: restate.ObjectContext,
        input: acp.PromptRequest,
      ): Promise<acp.PromptResponse> => {
        const acpSessionId = await ctx.get<string>("acpSessionId");
        if (!acpSessionId) {
          throw new restate.TerminalError(
            "No active session — call newSession first",
          );
        }

        const agent = await reconnectAgent(ctx);

        const text = input.prompt
          .filter(
            (b): b is { type: "text"; text: string } => b.type === "text",
          )
          .map((b) => b.text)
          .join("\n");

        try {
          const result = await agent.prompt({
            sessionId: acpSessionId,
            prompt: [{ type: "text", text }],
          });

          const history =
            (await ctx.get<
              Array<{ role: string; prompt?: acp.PromptRequest["prompt"] }>
            >("history")) ?? [];
          history.push({ role: "user", prompt: input.prompt });
          history.push({ role: "agent" });
          ctx.set("history", history);

          emit(ctx, {
            type: "prompt_complete",
            stopReason: result.stopReason,
          });

          const meta = await ctx.get<SessionState>("meta");
          if (meta) {
            meta.updatedAt = await ctx.date.toJSON();
            ctx.set("meta", meta);
          }

          return result;
        } catch (err) {
          const errorMsg =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err !== null
                ? JSON.stringify(err)
                : String(err);
          emit(ctx, { type: "prompt_failed", error: errorMsg });
          throw new restate.TerminalError(errorMsg);
        }
      },
    ),

    cancel: restate.handlers.object.shared(
      {
        output: restate.serde.schema(z.object({ cancelled: z.boolean() })),
      },
      async (_ctx: restate.ObjectSharedContext) => {
        // No cached connection to abort — agent process will be cleaned up
        // when the prompt handler returns or times out.
        return { cancelled: true };
      },
    ),

    getStatus: restate.handlers.object.shared(
      {
        output: restate.serde.schema(zSessionInfo.nullable()),
      },
      async (ctx: restate.ObjectSharedContext): Promise<SessionState | null> => {
        return ctx.get<SessionState>("meta");
      },
    ),

    resumePermission: restate.handlers.object.shared(
      {
        input: restate.serde.schema(ResumePermissionInput),
        output: restate.serde.schema(zRequestPermissionResponse),
      },
      async (
        ctx: restate.ObjectSharedContext,
        input: z.infer<typeof ResumePermissionInput>,
      ): Promise<acp.RequestPermissionResponse> => {
        const outcome: acp.RequestPermissionOutcome =
          input.outcome === "cancelled"
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: input.optionId! };

        ctx.resolveAwakeable(input.awakeableId, outcome);
        return { outcome };
      },
    ),

    close: restate.handlers.object.shared(
      {
        output: restate.serde.schema(zPromptResponse),
      },
      async (_ctx: restate.ObjectSharedContext): Promise<acp.PromptResponse> => {
        return { stopReason: "cancelled" };
      },
    ),

    listAgents: restate.handlers.object.shared(
      {},
      async (ctx: restate.ObjectSharedContext): Promise<AgentManifest[]> => {
        return ctx.run("fetch_agents", async () => {
          const agentIds = (process.env.ACP_AGENTS ?? "claude-acp")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const configs = await loadRegistryFromIds(agentIds);
          return configs.map((c) => c.manifest);
        });
      },
    ),
  },
});
