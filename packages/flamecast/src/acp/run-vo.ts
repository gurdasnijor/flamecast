/**
 * AcpRun — Restate Virtual Object implementing the ACP OpenAPI spec.
 *
 * Uses AgentRuntime for all Restate interactions (step, now, emit, state,
 * createDurablePromise). Transport-agnostic via AgentBackend.
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import { createRestateRuntime } from "../runtime/restate.js";
import type { AgentRuntime } from "../runtime/types.js";
import { createBackend, type AgentBackend } from "./agent-backend.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const backend: AgentBackend = createBackend();

function makeRuntime(ctx: restate.ObjectContext): AgentRuntime {
  return createRestateRuntime(ctx, { objectName: "AcpRun" });
}

// ─── State Types ────────────────────────────────────────────────────────────

export interface RunState {
  agentName: string;
  status: "created" | "in-progress" | "awaiting" | "completed" | "failed" | "cancelled";
  input: string;
  output?: string;
  error?: string;
  awaitRequest?: unknown;
  awakeableId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface RunEvent {
  type: string;
  timestamp: string;
  data?: unknown;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function execute(
  ctx: restate.ObjectContext,
  input: { agentName: string; prompt: string },
): Promise<RunState> {
  const runtime = makeRuntime(ctx);
  const runId = runtime.key;
  const now = await runtime.now();

  // ── created ─────────────────────────────────────────────────────────
  const runState: RunState = {
    agentName: input.agentName,
    status: "created",
    input: input.prompt,
    createdAt: now,
  };
  runtime.state.set("run", runState);
  runtime.emit({ type: "run.started", runId } as never);

  // ── connect to agent via backend ────────────────────────────────────
  const collectedText: string[] = [];

  const client: acp.Client = {
    async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
      const request = {
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? "Permission required",
        options: params.options.map((o: { optionId: string; name: string; kind: string }) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
      };

      // Durable promise — VO suspends with zero compute
      const generation = ((await runtime.state.get<number>("generation")) ?? 0) + 1;
      runtime.state.set("generation", generation);
      const dp = runtime.createDurablePromise<{ optionId: string }>("permission", generation);

      runState.status = "awaiting";
      runState.awaitRequest = request;
      runState.awakeableId = dp.id;
      runtime.state.set("run", runState);

      runtime.emit({
        type: "permission_request",
        requestId: params.toolCall.toolCallId,
        toolCallId: params.toolCall.toolCallId,
        title: request.title,
        options: request.options,
        awakeableId: dp.id,
        generation,
      } as never);

      // Suspend — zero compute until resolved externally
      const decision = await dp.promise;

      if (decision.optionId === "__cancelled__") {
        throw new acp.RequestError(-32000, "Cancelled");
      }

      runState.status = "in-progress";
      runState.awaitRequest = undefined;
      runState.awakeableId = undefined;
      runtime.state.set("run", runState);

      return { outcome: { outcome: "selected", optionId: decision.optionId } };
    },

    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        const text = update.content.text ?? "";
        collectedText.push(text);
        runtime.emit({ type: "text", text, role: "assistant" } as never);
      } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        runtime.emit({
          type: "tool",
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status,
        } as never);
      }
    },
  };

  // Connect outside ctx.run — live objects (ClientSideConnection) aren't serializable.
  // On replay, this re-establishes the connection (agent process re-spawns).
  const agentConn = await backend.connect(input.agentName, runId, client);

  runState.status = "in-progress";
  runtime.state.set("run", runState);

  // ── prompt — journaled. On replay, the result comes from journal, agent not re-invoked.
  const result = await runtime.step("prompt", () =>
    agentConn.conn.prompt({
      sessionId: agentConn.sessionId,
      prompt: [{ type: "text", text: input.prompt }],
    }),
  );

  // ── terminal state ──────────────────────────────────────────────────
  const output = collectedText.join("") || undefined;
  const completedAt = await runtime.now();
  const status =
    result.stopReason === "cancelled" ? "cancelled"
      : result.stopReason === "refusal" ? "failed"
      : "completed";

  runState.status = status as RunState["status"];
  runState.output = output;
  runState.completedAt = completedAt;
  runState.awakeableId = undefined;
  runtime.state.set("run", runState);

  runtime.emit({ type: "complete", result: { status, output, runId } } as never);

  await agentConn.transport.close();
  return runState;
}

async function getStatus(
  ctx: restate.ObjectSharedContext,
): Promise<RunState | null> {
  return ctx.get<RunState>("run");
}

async function resume(
  ctx: restate.ObjectSharedContext,
  input: { optionId: string },
): Promise<{ status: string }> {
  const run = await ctx.get<RunState>("run");
  if (!run) throw new restate.TerminalError("Run not found");
  if (run.status !== "awaiting") {
    throw new restate.TerminalError(`Run is ${run.status}, not awaiting`);
  }
  if (!run.awakeableId) {
    throw new restate.TerminalError("No awakeable to resolve");
  }

  ctx.resolveAwakeable(run.awakeableId, { optionId: input.optionId });
  return { status: "in-progress" };
}

async function cancel(
  ctx: restate.ObjectSharedContext,
): Promise<{ status: string }> {
  const run = await ctx.get<RunState>("run");
  if (!run) throw new restate.TerminalError("Run not found");

  if (run.status === "awaiting" && run.awakeableId) {
    ctx.resolveAwakeable(run.awakeableId, { optionId: "__cancelled__" });
  }

  return { status: "cancelling" };
}

// ─── Virtual Object Definition ──────────────────────────────────────────────

export const AcpRun = restate.object({
  name: "AcpRun",
  handlers: {
    execute,
    getStatus: restate.handlers.object.shared(getStatus),
    resume: restate.handlers.object.shared(resume),
    cancel: restate.handlers.object.shared(cancel),
  },
});
