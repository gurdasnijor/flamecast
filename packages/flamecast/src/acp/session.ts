/**
 * AcpSession — Restate Virtual Object for multi-turn agent sessions.
 *
 * Handler contracts use Zod schemas from @agentclientprotocol/sdk
 * directly, so the auto-generated OpenAPI matches the ACP spec.
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import {
  zNewSessionRequest,
  zNewSessionResponse,
  zPromptRequest,
  zPromptResponse,
  zRequestPermissionResponse,
  zSessionId,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";
import { createRestateRuntime } from "../runtime/restate.js";
import type { AgentRuntime } from "../runtime/types.js";
import { AcpClient } from "@flamecast/acp";
import { RegistryTransport } from "@flamecast/acp/transports/registry";

const agentIds = (process.env.ACP_AGENTS ?? "claude-acp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const acpClient = new AcpClient({
  transport: new RegistryTransport(agentIds),
});

function makeRuntime(ctx: restate.ObjectContext): AgentRuntime {
  return createRestateRuntime(ctx, { objectName: "AcpSession" });
}

// ─── Schemas ────────────────────────────────────────────────────────────────

// startSession extends ACP NewSessionRequest with agentName
const StartSessionInput = zNewSessionRequest.extend({
  agentName: z.string(),
});

// Session status — extends ACP with our lifecycle tracking
const SessionStatus = z.object({
  sessionId: zSessionId,
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

// resumeAgent — permission awakeableId + selected optionId
const ResumeAgentInput = z.object({
  awakeableId: z.string(),
  optionId: z.string(),
});

export type SessionState = z.infer<typeof SessionStatus>;

// ─── Handlers ───────────────────────────────────────────────────────────────

async function startSession(
  ctx: restate.ObjectContext,
  input: z.infer<typeof StartSessionInput>,
): Promise<acp.NewSessionResponse> {
  const runtime = makeRuntime(ctx);
  const sessionId = runtime.key;
  const now = await runtime.now();

  const meta: SessionState = {
    sessionId,
    agentName: input.agentName,
    status: "created",
    startedAt: now,
    lastUpdatedAt: now,
  };

  runtime.state.set("meta", meta);
  runtime.state.set("agentName", input.agentName);
  if (input.cwd) runtime.state.set("cwd", input.cwd);

  runtime.emit({ type: "session.created", meta } as never);

  ctx.objectSendClient(AcpSession, sessionId).conversationLoop();

  return { sessionId };
}

/**
 * Conversation loop — internal handler, not typed for OpenAPI.
 */
async function conversationLoop(ctx: restate.ObjectContext): Promise<void> {
  const runtime = makeRuntime(ctx);
  const sessionId = runtime.key;

  const agentName = await runtime.state.get<string>("agentName");
  if (!agentName) throw new restate.TerminalError("No agent configured");

  let acpSessionId: string | null = null;

  async function ensureConnection(): Promise<string> {
    if (!acpSessionId) {
      const handle = await acpClient.connect(agentName!, {
        cwd: (await runtime.state.get<string>("cwd")) ?? process.cwd(),
        onSessionUpdate(params: acp.SessionNotification) {
          const update = params.update;
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          ) {
            runtime.emit({
              type: "text",
              text: update.content.text ?? "",
              role: "assistant",
            } as never);
          } else if (
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          ) {
            runtime.emit({
              type: "tool",
              toolCallId: update.toolCallId,
              title: update.title,
              status: update.status,
            } as never);
          }
        },
        async onPermissionRequest(
          params: acp.RequestPermissionRequest,
        ): Promise<acp.RequestPermissionResponse> {
          const meta = await runtime.state.get<SessionState>("meta");
          if (meta) {
            meta.status = "awaiting";
            meta.lastUpdatedAt = await runtime.now();
            runtime.state.set("meta", meta);
          }

          const request = {
            toolCallId: params.toolCall.toolCallId,
            title: params.toolCall.title ?? "Permission required",
            options: params.options.map(
              (o: { optionId: string; name: string; kind: string }) => ({
                optionId: o.optionId,
                name: o.name,
                kind: o.kind,
              }),
            ),
          };

          const { id: awakeableId, promise } =
            ctx.awakeable<{ optionId: string }>();

          runtime.emit({
            type: "permission_request",
            requestId: request.toolCallId,
            toolCallId: request.toolCallId,
            title: request.title,
            options: request.options,
            awakeableId,
            generation: 0,
          } as never);

          const response = await promise;

          const metaAfter = await runtime.state.get<SessionState>("meta");
          if (metaAfter) {
            metaAfter.status = "in-progress";
            metaAfter.lastUpdatedAt = await runtime.now();
            runtime.state.set("meta", metaAfter);
          }

          return {
            outcome: { outcome: "selected", optionId: response.optionId },
          };
        },
      });
      acpSessionId = handle.sessionId;
    }
    return acpSessionId!;
  }

  while (true) {
    const { id: promptId, promise: promptPromise } =
      ctx.awakeable<acp.PromptRequest | null>();
    runtime.state.set("pending_prompt", { awakeableId: promptId });

    const next = await promptPromise;
    runtime.state.clear("pending_prompt");

    if (!next) break;

    const meta = await runtime.state.get<SessionState>("meta");
    if (meta) {
      meta.status = "in-progress";
      meta.lastUpdatedAt = await runtime.now();
      runtime.state.set("meta", meta);
    }

    const sid = await ensureConnection();

    // Extract text from ACP content blocks
    const text = next.prompt
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
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

      const metaDone = await runtime.state.get<SessionState>("meta");
      if (metaDone) {
        metaDone.status = status;
        metaDone.lastUpdatedAt = await runtime.now();
        runtime.state.set("meta", metaDone);
      }

      runtime.emit({
        type: "complete",
        result: { status, stopReason: result.stopReason, runId: sessionId },
      } as never);
    } catch (err) {
      const metaErr = await runtime.state.get<SessionState>("meta");
      if (metaErr) {
        metaErr.status = "failed";
        metaErr.lastUpdatedAt = await runtime.now();
        runtime.state.set("meta", metaErr);
      }

      runtime.emit({
        type: "complete",
        result: {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          runId: sessionId,
        },
      } as never);
    }
  }

  if (acpSessionId) {
    await acpClient.close(acpSessionId);
  }

  const metaKilled = await runtime.state.get<SessionState>("meta");
  if (metaKilled) {
    metaKilled.status = "killed";
    metaKilled.lastUpdatedAt = await runtime.now();
    runtime.state.set("meta", metaKilled);
  }
}

/**
 * Send a prompt — accepts ACP PromptRequest (content blocks).
 * Returns immediately with PromptResponse. Actual result comes via events.
 */
async function sendPrompt(
  ctx: restate.ObjectSharedContext,
  input: acp.PromptRequest,
): Promise<acp.PromptResponse> {
  const pending = await ctx.get<{ awakeableId: string }>("pending_prompt");
  if (!pending) {
    throw new restate.TerminalError(
      "No pending prompt — session may not be running or is mid-turn",
    );
  }
  ctx.resolveAwakeable(pending.awakeableId, input);
  return { stopReason: "end_turn" };
}

async function getStatus(
  ctx: restate.ObjectSharedContext,
): Promise<SessionState | null> {
  return ctx.get<SessionState>("meta");
}

async function resumeAgent(
  ctx: restate.ObjectSharedContext,
  input: z.infer<typeof ResumeAgentInput>,
): Promise<acp.RequestPermissionResponse> {
  ctx.resolveAwakeable(input.awakeableId, { optionId: input.optionId });
  return {
    outcome: { outcome: "selected", optionId: input.optionId },
  };
}

async function terminateSession(
  ctx: restate.ObjectContext,
): Promise<acp.PromptResponse> {
  const runtime = makeRuntime(ctx);

  const pending = await ctx.get<{ awakeableId: string }>("pending_prompt");
  if (pending) {
    ctx.resolveAwakeable(pending.awakeableId, null);
  }

  const meta = await runtime.state.get<SessionState>("meta");
  if (meta) {
    meta.status = "killed";
    meta.lastUpdatedAt = await runtime.now();
    runtime.state.set("meta", meta);
  }

  runtime.emit({ type: "session.terminated" } as never);

  return { stopReason: "cancelled" };
}

// ─── Virtual Object Definition ──────────────────────────────────────────────

export const AcpSession = restate.object({
  name: "AcpSession",
  handlers: {
    startSession: restate.handlers.object.exclusive(
      {
        input: restate.serde.schema(StartSessionInput),
        output: restate.serde.schema(zNewSessionResponse),
      },
      startSession,
    ),
    conversationLoop,
    sendPrompt: restate.handlers.object.shared(
      {
        input: restate.serde.schema(zPromptRequest),
        output: restate.serde.schema(zPromptResponse),
      },
      sendPrompt,
    ),
    getStatus: restate.handlers.object.shared(
      {
        output: restate.serde.schema(SessionStatus.nullable()),
      },
      getStatus,
    ),
    resumeAgent: restate.handlers.object.shared(
      {
        input: restate.serde.schema(ResumeAgentInput),
        output: restate.serde.schema(zRequestPermissionResponse),
      },
      resumeAgent,
    ),
    terminateSession: restate.handlers.object.exclusive(
      {
        output: restate.serde.schema(zPromptResponse),
      },
      terminateSession,
    ),
  },
});
