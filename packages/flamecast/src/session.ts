/**
 * AcpSession — Restate Virtual Object for multi-turn agent sessions.
 *
 * Keyed by session ID. Maintains a persistent agent connection across
 * multiple prompt turns via a conversation loop.
 *
 * Handler contracts use Zod schemas from @agentclientprotocol/sdk
 * for typed input/output (auto-generates OpenAPI 3.1).
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
import { AcpClient } from "@flamecast/acp";
import { RegistryTransport } from "@flamecast/acp/transports/registry";

// ─── ACP transport client ───────────────────────────────────────────────────

const agentIds = (process.env.ACP_AGENTS ?? "claude-acp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const acpClient = new AcpClient({
  transport: new RegistryTransport(agentIds),
});

// ─── Schemas ────────────────────────────────────────────────────────────────

const StartSessionInput = zNewSessionRequest.extend({
  agentName: z.string(),
});

const SessionStatus = zSessionInfo.extend({
  agentName: z.string(),
  status: z.enum([
    "created",
    "in-progress",
    "awaiting",
    "completed",
    "failed",
    "cancelled",
    "killed",
  ]),
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
});

const ResumeAgentInput = z.object({
  awakeableId: z.string(),
  optionId: z.string().optional(),
  outcome: z.enum(["selected", "cancelled"]).default("selected"),
});

export type SessionState = z.infer<typeof SessionStatus>;
export type RunStatus = SessionState["status"];

import { createPubsubClient } from "@restatedev/pubsub-client";

const pubsub = createPubsubClient({
  name: "pubsub",
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

function emit(ctx: restate.ObjectContext, event: Record<string, unknown>) {
  pubsub.publish(`session:${ctx.key}`, event, ctx.rand.uuidv4());
}

// ─── Virtual Object ─────────────────────────────────────────────────────────

export const AcpSession = restate.object({
  name: "AcpSession",
  handlers: {
    startSession: restate.handlers.object.exclusive(
      {
        input: restate.serde.schema(StartSessionInput),
        output: restate.serde.schema(zNewSessionResponse),
      },
      async (
        ctx: restate.ObjectContext,
        input: z.infer<typeof StartSessionInput>,
      ): Promise<acp.NewSessionResponse> => {
        const sessionId = ctx.key;
        const now = await ctx.date.toJSON();

        const meta: SessionState = {
          sessionId,
          cwd: input.cwd,
          agentName: input.agentName,
          status: "created",
          startedAt: now,
          lastUpdatedAt: now,
        };

        ctx.set("meta", meta);
        ctx.set("agentName", input.agentName);
        if (input.cwd) ctx.set("cwd", input.cwd);

        emit(ctx, { type: "session.created", meta });

        ctx.objectSendClient(AcpSession, sessionId).conversationLoop();

        return { sessionId };
      },
    ),

    /**
     * Conversation loop — internal. Single invocation for the entire session.
     * Suspends on awakeables between turns (zero compute).
     */
    conversationLoop: async (ctx: restate.ObjectContext): Promise<void> => {
      const sessionId = ctx.key;
      const agentName = await ctx.get<string>("agentName");
      if (!agentName) throw new restate.TerminalError("No agent configured");

      let acpSessionId: string | null = null;

      async function ensureConnection(): Promise<string> {
        if (!acpSessionId) {
          const handle = await acpClient.connect(agentName!, {
            cwd: (await ctx.get<string>("cwd")) ?? process.cwd(),

            onSessionUpdate(params: acp.SessionNotification) {
              const update = params.update;
              if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text"
              ) {
                emit(ctx, {
                  type: "text",
                  text: update.content.text ?? "",
                  role: "assistant",
                });
              } else if (
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update"
              ) {
                emit(ctx, {
                  type: "tool",
                  toolCallId: update.toolCallId,
                  title: update.title,
                  status: update.status,
                });
              }
            },

            async onPermissionRequest(
              params: acp.RequestPermissionRequest,
            ): Promise<acp.RequestPermissionResponse> {
              const meta = await ctx.get<SessionState>("meta");
              if (meta) {
                meta.status = "awaiting";
                meta.lastUpdatedAt = await ctx.date.toJSON();
                ctx.set("meta", meta);
              }

              const { id: awakeableId, promise } =
                ctx.awakeable<acp.RequestPermissionOutcome>();

              emit(ctx, {
                type: "permission_request",
                requestId: params.toolCall.toolCallId,
                toolCallId: params.toolCall.toolCallId,
                title: params.toolCall.title ?? "Permission required",
                options: params.options.map((o) => ({
                  optionId: o.optionId,
                  name: o.name,
                  kind: o.kind,
                })),
                awakeableId,
              });

              const outcome = await promise;

              const metaAfter = await ctx.get<SessionState>("meta");
              if (metaAfter) {
                metaAfter.status = "in-progress";
                metaAfter.lastUpdatedAt = await ctx.date.toJSON();
                ctx.set("meta", metaAfter);
              }

              return { outcome };
            },
          });
          acpSessionId = handle.sessionId;
        }
        return acpSessionId!;
      }

      // ── Main loop ───────────────────────────────────────────────────────
      while (true) {
        const { id: promptId, promise: promptPromise } =
          ctx.awakeable<acp.PromptRequest | null>();
        ctx.set("pending_prompt", { awakeableId: promptId });

        const next = await promptPromise;
        ctx.clear("pending_prompt");

        if (!next) break;

        const meta = await ctx.get<SessionState>("meta");
        if (meta) {
          meta.status = "in-progress";
          meta.lastUpdatedAt = await ctx.date.toJSON();
          ctx.set("meta", meta);
        }

        const sid = await ensureConnection();

        const text = next.prompt
          .filter(
            (b): b is { type: "text"; text: string } => b.type === "text",
          )
          .map((b) => b.text)
          .join("\n");

        try {
          const result = await acpClient.prompt(sid, text);

          const status =
            result.stopReason === "cancelled"
              ? "cancelled"
              : result.stopReason === "refusal"
                ? "failed"
                : "completed";

          const metaDone = await ctx.get<SessionState>("meta");
          if (metaDone) {
            metaDone.status = status;
            metaDone.lastUpdatedAt = await ctx.date.toJSON();
            ctx.set("meta", metaDone);
          }

          emit(ctx, {
            type: "complete",
            result: {
              status,
              stopReason: result.stopReason,
              runId: sessionId,
            },
          });
        } catch (err) {
          const metaErr = await ctx.get<SessionState>("meta");
          if (metaErr) {
            metaErr.status = "failed";
            metaErr.lastUpdatedAt = await ctx.date.toJSON();
            ctx.set("meta", metaErr);
          }

          emit(ctx, {
            type: "complete",
            result: {
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
              runId: sessionId,
            },
          });
        }
      }

      // Clean up
      if (acpSessionId) {
        await acpClient.close(acpSessionId);
      }

      const metaKilled = await ctx.get<SessionState>("meta");
      if (metaKilled) {
        metaKilled.status = "killed";
        metaKilled.lastUpdatedAt = await ctx.date.toJSON();
        ctx.set("meta", metaKilled);
      }
    },

    sendPrompt: restate.handlers.object.shared(
      {
        input: restate.serde.schema(zPromptRequest),
        output: restate.serde.schema(zPromptResponse),
      },
      async (
        ctx: restate.ObjectSharedContext,
        input: acp.PromptRequest,
      ): Promise<acp.PromptResponse> => {
        const pending = await ctx.get<{ awakeableId: string }>(
          "pending_prompt",
        );
        if (!pending) {
          throw new restate.TerminalError(
            "No pending prompt — session may not be running or is mid-turn",
          );
        }
        ctx.resolveAwakeable(pending.awakeableId, input);
        return { stopReason: "end_turn" };
      },
    ),

    getStatus: restate.handlers.object.shared(
      {
        output: restate.serde.schema(SessionStatus.nullable()),
      },
      async (
        ctx: restate.ObjectSharedContext,
      ): Promise<SessionState | null> => {
        return ctx.get<SessionState>("meta");
      },
    ),

    resumeAgent: restate.handlers.object.shared(
      {
        input: restate.serde.schema(ResumeAgentInput),
        output: restate.serde.schema(zRequestPermissionResponse),
      },
      async (
        ctx: restate.ObjectSharedContext,
        input: z.infer<typeof ResumeAgentInput>,
      ): Promise<acp.RequestPermissionResponse> => {
        const outcome: acp.RequestPermissionOutcome =
          input.outcome === "cancelled"
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: input.optionId! };

        ctx.resolveAwakeable(input.awakeableId, outcome);
        return { outcome };
      },
    ),

    terminateSession: restate.handlers.object.exclusive(
      {
        output: restate.serde.schema(zPromptResponse),
      },
      async (
        ctx: restate.ObjectContext,
      ): Promise<acp.PromptResponse> => {
        const pending = await ctx.get<{ awakeableId: string }>(
          "pending_prompt",
        );
        if (pending) {
          ctx.resolveAwakeable(pending.awakeableId, null);
        }

        const meta = await ctx.get<SessionState>("meta");
        if (meta) {
          meta.status = "killed";
          meta.lastUpdatedAt = await ctx.date.toJSON();
          ctx.set("meta", meta);
        }

        emit(ctx, { type: "session.terminated" });

        return { stopReason: "cancelled" };
      },
    ),
  },
});
