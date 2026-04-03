/**
 * AcpSession — Restate Virtual Object for multi-turn agent sessions.
 *
 * Keyed by session ID. Maintains a persistent agent connection across
 * multiple prompt turns via a conversation loop.
 *
 * Session state is ACP SessionInfo. Turn lifecycle (in-progress,
 * awaiting, completed, failed) is communicated via pubsub events
 * using ACP's native types (StopReason, ToolCallStatus, etc).
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import {
  zNewSessionRequest,
  zNewSessionResponse,
  zInitializeResponse,
  zPromptRequest,
  zPromptResponse,
  zRequestPermissionResponse,
  zSessionInfo,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";
import { createPubsubClient } from "@restatedev/pubsub-client";
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

// ─── Pubsub ─────────────────────────────────────────────────────────────────

const pubsub = createPubsubClient({
  name: "pubsub",
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

function emit(ctx: restate.ObjectContext, event: Record<string, unknown>) {
  pubsub.publish(`session:${ctx.key}`, event, ctx.rand.uuidv4());
}

// ─── Schemas ────────────────────────────────────────────────────────────────

// agentName passed via _meta.agentName (ACP extensibility)
const StartSessionInput = zNewSessionRequest;
const StartSessionOutput = zInitializeResponse.partial().merge(zNewSessionResponse);

const ResumeAgentInput = z.object({
  awakeableId: z.string(),
  optionId: z.string().optional(),
  outcome: z.enum(["selected", "cancelled"]).default("selected"),
});

// Session state is pure ACP SessionInfo
export type SessionState = acp.SessionInfo;

// ─── Virtual Object ─────────────────────────────────────────────────────────

export const AcpSession = restate.object({
  name: "AcpSession",
  handlers: {
    startSession: restate.handlers.object.exclusive(
      {
        input: restate.serde.schema(StartSessionInput),
        output: restate.serde.schema(StartSessionOutput),
      },
      async (ctx: restate.ObjectContext, input: acp.NewSessionRequest) => {
        const sessionId = ctx.key;
        const agentName = (input._meta?.agentName as string) ?? "claude-acp";

        // Connect briefly to get agent capabilities, then close.
        // The conversation loop will create its own connection with callbacks.
        const handle = await acpClient.connect(agentName, { cwd: input.cwd });
        await acpClient.close(handle.sessionId);

        const meta: SessionState = {
          sessionId,
          cwd: input.cwd,
        };

        ctx.set("meta", meta);
        ctx.set("agentName", agentName);
        if (handle.modes) ctx.set("modes", handle.modes);

        emit(ctx, { type: "session.created", sessionId });

        ctx.objectSendClient(AcpSession, sessionId).conversationLoop();

        return {
          ...handle,
          sessionId,
        } as z.infer<typeof StartSessionOutput>;
      },
    ),

    conversationLoop: async (ctx: restate.ObjectContext): Promise<void> => {
      const agentName = await ctx.get<string>("agentName");
      if (!agentName) throw new restate.TerminalError("No agent configured");

      let acpSessionId: string | null = null;

      async function ensureConnection(): Promise<string> {
        if (!acpSessionId) {
          const handle = await acpClient.connect(agentName!, {
            cwd: (await ctx.get<string>("cwd")) ?? process.cwd(),

            onSessionUpdate(params: acp.SessionNotification) {
              emit(ctx, {
                type: "session_update",
                sessionUpdate: params.update.sessionUpdate,
                update: params.update,
              });
            },

            async onPermissionRequest(
              params: acp.RequestPermissionRequest,
            ): Promise<acp.RequestPermissionResponse> {
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
          });
          acpSessionId = handle.sessionId;
          ctx.set("acpSessionId", acpSessionId);
        }
        return acpSessionId!;
      }

      while (true) {
        const { id: promptId, promise: promptPromise } =
          ctx.awakeable<acp.PromptRequest | null>();
        ctx.set("pending_prompt", { awakeableId: promptId });

        const next = await promptPromise;
        ctx.clear("pending_prompt");

        if (!next) break;

        const sid = await ensureConnection();

        const text = next.prompt
          .filter(
            (b): b is { type: "text"; text: string } => b.type === "text",
          )
          .map((b) => b.text)
          .join("\n");

        try {
          const result = await acpClient.prompt(sid, text);

          emit(ctx, {
            type: "prompt_complete",
            stopReason: result.stopReason,
          });
        } catch (err) {
          emit(ctx, {
            type: "prompt_failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Update SessionInfo.updatedAt
        const meta = await ctx.get<SessionState>("meta");
        if (meta) {
          meta.updatedAt = await ctx.date.toJSON();
          ctx.set("meta", meta);
        }
      }

      if (acpSessionId) {
        await acpClient.close(acpSessionId);
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

    cancel: restate.handlers.object.shared(
      {
        output: restate.serde.schema(z.object({ cancelled: z.boolean() })),
      },
      async (ctx: restate.ObjectSharedContext) => {
        const acpSessionId = await ctx.get<string>("acpSessionId");
        if (acpSessionId) {
          await acpClient.cancel(acpSessionId);
          return { cancelled: true };
        }
        return { cancelled: false };
      },
    ),

    getStatus: restate.handlers.object.shared(
      {
        output: restate.serde.schema(zSessionInfo.nullable()),
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
      async (ctx: restate.ObjectContext): Promise<acp.PromptResponse> => {
        const pending = await ctx.get<{ awakeableId: string }>(
          "pending_prompt",
        );
        if (pending) {
          ctx.resolveAwakeable(pending.awakeableId, null);
        }

        emit(ctx, { type: "session.terminated" });

        return { stopReason: "cancelled" };
      },
    ),
  },
});
