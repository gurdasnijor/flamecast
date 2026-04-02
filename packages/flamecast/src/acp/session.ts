/**
 * AcpSession — Restate Virtual Object for multi-turn agent sessions.
 *
 * Keyed by session ID. Maintains a persistent agent connection across
 * multiple prompt turns. Uses the conversation loop pattern:
 *
 *   startSession → conversationLoop (fire-and-forget)
 *     while(true):
 *       suspend on awakeable (wait for sendPrompt)
 *       drive agent via AcpClient
 *       permission requests → awakeables (zero-cost suspension)
 *       stream events → pubsub
 *       emit result → loop back
 *
 * One Restate invocation per session. Zero compute between turns.
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
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

// ─── State Types ────────────────────────────────────────────────────────────

export interface SessionState {
  agentName: string;
  status: "active" | "running" | "paused" | "completed" | "failed" | "killed";
  startedAt: string;
  lastUpdatedAt: string;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function startSession(
  ctx: restate.ObjectContext,
  input: { agentName: string; cwd?: string },
): Promise<{ sessionId: string; agentName: string }> {
  const runtime = makeRuntime(ctx);
  const sessionId = runtime.key;
  const now = await runtime.now();

  const meta: SessionState = {
    agentName: input.agentName,
    status: "active",
    startedAt: now,
    lastUpdatedAt: now,
  };

  runtime.state.set("meta", meta);
  runtime.state.set("agentName", input.agentName);
  if (input.cwd) runtime.state.set("cwd", input.cwd);

  runtime.emit({ type: "session.created", meta } as never);

  // Fire-and-forget: start the conversation loop
  ctx.objectSendClient(AcpSession, sessionId).conversationLoop();

  return { sessionId, agentName: input.agentName };
}

/**
 * Conversation loop — single invocation for the entire session.
 *
 * Kicked off by startSession. Loops:
 *   suspend → receive prompt → connect to agent → drive → emit result → loop
 *
 * One Restate invocation per session. Zero compute between turns.
 */
async function conversationLoop(ctx: restate.ObjectContext): Promise<void> {
  const runtime = makeRuntime(ctx);
  const sessionId = runtime.key;

  const agentName = await runtime.state.get<string>("agentName");
  if (!agentName) throw new restate.TerminalError("No agent configured");

  // Connect to agent via AcpClient — wires callbacks to pubsub + awakeables
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
    // ── Suspend: wait for next prompt via sendPrompt ──────────────────
    const { id: promptId, promise: promptPromise } =
      ctx.awakeable<{ text: string } | null>();
    runtime.state.set("pending_prompt", { awakeableId: promptId });

    const next = await promptPromise;
    runtime.state.clear("pending_prompt");

    if (!next) break; // null = session terminated

    // ── Update status ────────────────────────────────────────────────
    const meta = await runtime.state.get<SessionState>("meta");
    if (meta) {
      meta.status = "running";
      meta.lastUpdatedAt = await runtime.now();
      runtime.state.set("meta", meta);
    }

    // ── Connect (or reuse) agent ─────────────────────────────────────
    const sid = await ensureConnection();

    // ── Drive agent with prompt ──────────────────────────────────────
    try {
      const result = await acpClient.prompt(sid, next.text);

      runtime.emit({
        type: "complete",
        result: {
          status:
            result.stopReason === "cancelled"
              ? "cancelled"
              : result.stopReason === "refusal"
                ? "failed"
                : "completed",
          runId: sessionId,
        },
      } as never);
    } catch (err) {
      runtime.emit({
        type: "complete",
        result: {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          runId: sessionId,
        },
      } as never);
    }

    // ── Update status back to active ─────────────────────────────────
    const metaAfter = await runtime.state.get<SessionState>("meta");
    if (metaAfter) {
      metaAfter.status = "active";
      metaAfter.lastUpdatedAt = await runtime.now();
      runtime.state.set("meta", metaAfter);
    }

    // Loop back — suspend on next awakeable
  }

  // Clean up (reachable when null is sent to break the loop)
  if (acpSessionId) {
    await acpClient.close(acpSessionId);
  }
}

/** Send a prompt to the conversation loop. Shared handler. */
async function sendPrompt(
  ctx: restate.ObjectSharedContext,
  input: { text: string },
): Promise<void> {
  const pending = await ctx.get<{ awakeableId: string }>("pending_prompt");
  if (!pending) {
    throw new restate.TerminalError(
      "No pending prompt — session may not be running or is mid-turn",
    );
  }
  ctx.resolveAwakeable(pending.awakeableId, { text: input.text });
}

/** Get session status. Shared handler. */
async function getStatus(
  ctx: restate.ObjectSharedContext,
): Promise<SessionState | null> {
  return ctx.get<SessionState>("meta");
}

/** Resume a permission request. Shared handler. */
async function resumeAgent(
  ctx: restate.ObjectSharedContext,
  input: { awakeableId: string; optionId: string },
): Promise<void> {
  ctx.resolveAwakeable(input.awakeableId, { optionId: input.optionId });
}

/** Terminate the session. */
async function terminateSession(
  ctx: restate.ObjectContext,
): Promise<void> {
  const runtime = makeRuntime(ctx);

  // Send null to conversation loop to break it
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
}

// ─── Virtual Object Definition ──────────────────────────────────────────────

export const AcpSession = restate.object({
  name: "AcpSession",
  handlers: {
    startSession,
    conversationLoop,
    sendPrompt: restate.handlers.object.shared(sendPrompt),
    getStatus: restate.handlers.object.shared(getStatus),
    resumeAgent: restate.handlers.object.shared(resumeAgent),
    terminateSession,
  },
});
