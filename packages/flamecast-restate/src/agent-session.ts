/**
 * AgentSession — unified Restate Virtual Object for all ACP agents.
 *
 * VO state is decomposed into three concerns with different lifetimes:
 *
 * 'agent'      — AgentManifest: identity + protocol. Set once, never changes.
 * 'connection' — ConnectionHandle: live connection info. Set at start, may update.
 * 'meta'       — SessionMeta: status + timestamps. Updated throughout.
 * 'cwd'        — Working directory. Set at start.
 *
 * Adapter selection: agent.protocol → stdio or a2a. No inference.
 *
 * Reference: docs/re-arch-unification.md
 */

import * as restate from "@restatedev/restate-sdk";
import type { PromptResult, AgentStartConfig, SessionMeta, SessionHandle } from "./adapter.js";
import type { SessionEvent } from "@flamecast/protocol/session";
import type { AgentRuntime } from "@flamecast/runtime";
import { createRestateRuntime } from "@flamecast/runtime/restate";
import { ZedAcpAdapter } from "./zed-acp-adapter.js";
import { IbmAcpAdapter } from "./ibm-acp-adapter.js";
import { sharedHandlers, handleResult } from "./shared-handlers.js";

const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Decomposed state types ──────────────────────────────────────────────

/** Stable agent identity — set once at startSession, never changes. */
interface AgentManifest {
  protocol: "stdio" | "a2a";
  name: string;
  description?: string;
  capabilities?: Record<string, unknown>;
  endpoint: string;
  args?: string[];
}

/** Connection info — set at start, may update on reconnect. */
interface ConnectionHandle {
  url?: string;
  pid?: number;
  containerId?: string;
  sandboxId?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeRuntime(ctx: restate.ObjectContext): AgentRuntime {
  return createRestateRuntime(ctx, { objectName: "AgentSession" });
}

/** Reconstruct a SessionHandle from decomposed state (for adapter calls). */
function toSessionHandle(
  sessionId: string,
  agent: AgentManifest,
  connection: ConnectionHandle,
): SessionHandle {
  return {
    sessionId,
    protocol: agent.protocol === "a2a" ? "ibm" : "zed",
    agent: {
      name: agent.name,
      description: agent.description,
      capabilities: agent.capabilities,
    },
    connection,
  };
}

/** Read agent + connection from state, build session handle. */
async function loadSession(
  runtime: AgentRuntime,
): Promise<{ agent: AgentManifest; handle: SessionHandle }> {
  const agent = await runtime.state.get<AgentManifest>("agent");
  if (!agent) throw new restate.TerminalError("No active session");
  const connection =
    (await runtime.state.get<ConnectionHandle>("connection")) ?? {};
  return { agent, handle: toSessionHandle(runtime.key, agent, connection) };
}

function createPermissionHandler(runtime: AgentRuntime) {
  return async (
    params: import("@agentclientprotocol/sdk").RequestPermissionRequest,
  ) => {
    const generation =
      ((await runtime.state.get<number>("generation")) ?? 0) + 1;
    runtime.state.set("generation", generation);

    const permissionRequest = {
      requestId: params.toolCall.toolCallId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "Permission required",
      kind: params.toolCall.kind ?? undefined,
      options: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
    };

    const dp = runtime.createDurablePromise<{ optionId: string }>(
      "permission",
      generation,
    );

    runtime.emit({
      type: "permission_request",
      ...permissionRequest,
      awakeableId: dp.id,
      generation,
    });

    const response = await dp.promise;
    runtime.state.clear("pending_pause");

    return {
      outcome: { outcome: "selected" as const, optionId: response.optionId },
    };
  };
}

// ─── Virtual Object ──────────────────────────────────────────────────────

export const AgentSession = restate.object({
  name: "AgentSession",
  handlers: {
    ...sharedHandlers,

    startSession: async (
      ctx: restate.ObjectContext,
      input: AgentStartConfig & { protocol?: "stdio" | "a2a" },
    ): Promise<SessionHandle> => {
      const runtime = makeRuntime(ctx);
      const protocol = input.protocol ?? "stdio";

      // Start via the protocol-appropriate adapter
      let session: SessionHandle;
      if (protocol === "a2a") {
        const raw = await runtime.step("start", () =>
          new IbmAcpAdapter().start(input),
        );
        session = { ...raw, protocol: "ibm" as const };
      } else {
        session = await runtime.step("start", () =>
          new ZedAcpAdapter().start(input),
        );
      }

      // Decompose into separate state keys
      const agent: AgentManifest = {
        protocol,
        name: session.agent.name,
        description: session.agent.description,
        capabilities: session.agent.capabilities,
        endpoint: input.agent,
        args: input.args,
      };

      const connection: ConnectionHandle = { ...session.connection };

      const now = runtime.now();
      const meta: SessionMeta = {
        sessionId: runtime.key,
        protocol: session.protocol,
        agent: session.agent,
        status: "active",
        startedAt: now,
        lastUpdatedAt: now,
      };

      runtime.state.set("agent", agent);
      runtime.state.set("connection", connection);
      runtime.state.set("meta", meta);
      if (input.cwd) runtime.state.set("cwd", input.cwd);

      runtime.emit({ type: "session.created", meta });
      return session;
    },

    runAgent: async (
      ctx: restate.ObjectContext,
      input: { text: string },
    ): Promise<PromptResult> => {
      const runtime = makeRuntime(ctx);
      const { agent, handle } = await loadSession(runtime);

      if (agent.protocol === "a2a") {
        const adapter = new IbmAcpAdapter();
        const { runId } = await runtime.step("create-run", () =>
          adapter.createRun(handle, input.text),
        );
        runtime.emit({ type: "run.started", runId });

        const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
        runtime.state.set("pending_run", { awakeableId, runId });
        const result = await promise;
        runtime.state.clear("pending_run");

        return handleResult(ctx, runtime, adapter, handle, result);
      } else {
        const adapter = new ZedAcpAdapter();
        adapter.setPermissionHandler(handle, createPermissionHandler(runtime));
        adapter.setPublishSink(handle, (event) => {
          runtime.emit(event as SessionEvent);
        });

        const result = await adapter.promptSync(handle, input.text);

        adapter.setPermissionHandler(handle, null);
        adapter.setPublishSink(handle, null);

        return handleResult(ctx, runtime, adapter, handle, result);
      }
    },

    cancelAgent: async (
      ctx: restate.ObjectContext,
    ): Promise<{ cancelled: boolean }> => {
      const runtime = makeRuntime(ctx);
      const { agent, handle } = await loadSession(runtime);

      if (agent.protocol === "a2a") {
        await runtime.step("cancel", () => new IbmAcpAdapter().cancel(handle));
      } else {
        await runtime.step("cancel", () => new ZedAcpAdapter().cancel(handle));
      }

      runtime.state.clear("pending_pause");
      runtime.state.clear("pending_run");
      return { cancelled: true };
    },

    steerAgent: async (
      ctx: restate.ObjectContext,
      input: { newText: string; mode?: string; model?: string },
    ): Promise<PromptResult> => {
      const runtime = makeRuntime(ctx);
      const { agent, handle } = await loadSession(runtime);

      if (agent.protocol === "a2a") {
        const adapter = new IbmAcpAdapter();
        await runtime.step("cancel", () => adapter.cancel(handle));
        if (input.mode)
          await runtime.step("set-mode", () =>
            adapter.setConfigOption(handle, "mode", input.mode!),
          );
        if (input.model)
          await runtime.step("set-model", () =>
            adapter.setConfigOption(handle, "model", input.model!),
          );
      } else {
        const adapter = new ZedAcpAdapter();
        await runtime.step("cancel", () => adapter.cancel(handle));
        if (input.mode)
          await runtime.step("set-mode", () =>
            adapter.setConfigOption(handle, "mode", input.mode!),
          );
        if (input.model)
          await runtime.step("set-model", () =>
            adapter.setConfigOption(handle, "model", input.model!),
          );
      }

      return ctx
        .objectClient(AgentSession, ctx.key)
        .runAgent({ text: input.newText });
    },

    terminateSession: async (ctx: restate.ObjectContext): Promise<void> => {
      const runtime = makeRuntime(ctx);
      const agentManifest = await runtime.state.get<AgentManifest>("agent");
      if (agentManifest) {
        const connection =
          (await runtime.state.get<ConnectionHandle>("connection")) ?? {};
        const handle = toSessionHandle(
          runtime.key,
          agentManifest,
          connection,
        );
        if (agentManifest.protocol === "a2a") {
          await runtime.step("close", () =>
            new IbmAcpAdapter().close(handle),
          );
        } else {
          await runtime.step("close", () =>
            new ZedAcpAdapter().close(handle),
          );
        }
      }

      const meta = await runtime.state.get<SessionMeta>("meta");
      if (meta) {
        runtime.state.set("meta", {
          ...meta,
          status: "killed" as const,
          lastUpdatedAt: runtime.now(),
        });
      }

      runtime.emit({ type: "session.terminated" });
      runtime.scheduleCleanup(CLEANUP_DELAY_MS);
    },
  },
});
