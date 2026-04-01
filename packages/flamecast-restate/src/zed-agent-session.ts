/**
 * ZedAgentSession — Restate Virtual Object for Zed ACP agents.
 *
 * promptSync runs OUTSIDE ctx.run() so the FlamecastClient's
 * requestPermission() callback can create awakeables and publish
 * to pubsub. The prompt itself is ephemeral (not journaled); only
 * the final result + permission awakeables are durable.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §5.2
 */

import * as restate from "@restatedev/restate-sdk";
import type {
  SessionHandle,
  PromptResult,
  AgentStartConfig,
  SessionMeta,
} from "./adapter.js";
import type { SessionEvent } from "@flamecast/protocol/session";
import type { AgentRuntime } from "@flamecast/runtime";
import { createRestateRuntime } from "@flamecast/runtime/restate";
import { ZedAcpAdapter } from "./zed-acp-adapter.js";
import { sharedHandlers, handleResult } from "./shared-handlers.js";

const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

function makeRuntime(ctx: restate.ObjectContext): AgentRuntime {
  return createRestateRuntime(ctx, { objectName: "ZedAgentSession" });
}

/**
 * Create a permission handler that uses Restate awakeables + pubsub.
 * Follows the same generation counter pattern as handleAwaiting in
 * shared-handlers.ts.
 */
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

    const event: SessionEvent = {
      type: "permission_request",
      ...permissionRequest,
      awakeableId: dp.id,
      generation,
    };
    runtime.emit(event);

    const response = await dp.promise;
    runtime.state.clear("pending_pause");

    return {
      outcome: {
        outcome: "selected" as const,
        optionId: response.optionId,
      },
    };
  };
}

export const ZedAgentSession = restate.object({
  name: "ZedAgentSession",
  handlers: {
    ...sharedHandlers,

    startSession: async (
      ctx: restate.ObjectContext,
      input: AgentStartConfig,
    ): Promise<SessionHandle> => {
      const runtime = makeRuntime(ctx);
      const adapter = new ZedAcpAdapter();
      const session = await runtime.step("start", () => adapter.start(input));

      const now = runtime.now();
      const meta: SessionMeta = {
        sessionId: runtime.key,
        protocol: "zed",
        agent: session.agent,
        status: "active",
        startedAt: now,
        lastUpdatedAt: now,
      };
      runtime.state.set("session", session);
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
      const session = await runtime.state.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new ZedAcpAdapter();

      // Inject permission handler + publish sink using runtime
      adapter.setPermissionHandler(
        session,
        createPermissionHandler(runtime),
      );
      adapter.setPublishSink(session, (event) => {
        runtime.emit(event as SessionEvent);
      });

      // Run prompt OUTSIDE ctx.run() — ephemeral, not journaled.
      const result = await adapter.promptSync(session, input.text);

      adapter.setPermissionHandler(session, null);
      adapter.setPublishSink(session, null);

      return handleResult(ctx, runtime, adapter, session, result);
    },

    cancelAgent: async (
      ctx: restate.ObjectContext,
    ): Promise<{ cancelled: boolean }> => {
      const runtime = makeRuntime(ctx);
      const session = await runtime.state.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      await runtime.step("cancel", () => new ZedAcpAdapter().cancel(session));
      runtime.state.clear("pending_pause");
      return { cancelled: true };
    },

    steerAgent: async (
      ctx: restate.ObjectContext,
      input: { newText: string; mode?: string; model?: string },
    ): Promise<PromptResult> => {
      const runtime = makeRuntime(ctx);
      const session = await runtime.state.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new ZedAcpAdapter();

      await runtime.step("cancel", () => adapter.cancel(session));
      if (input.mode) {
        await runtime.step("set-mode", () =>
          adapter.setConfigOption(session, "mode", input.mode!),
        );
      }
      if (input.model) {
        await runtime.step("set-model", () =>
          adapter.setConfigOption(session, "model", input.model!),
        );
      }

      adapter.setPermissionHandler(
        session,
        createPermissionHandler(runtime),
      );
      adapter.setPublishSink(session, (event) => {
        runtime.emit(event as SessionEvent);
      });
      const result = await adapter.promptSync(session, input.newText);
      adapter.setPermissionHandler(session, null);
      adapter.setPublishSink(session, null);

      return handleResult(ctx, runtime, adapter, session, result);
    },

    terminateSession: async (ctx: restate.ObjectContext): Promise<void> => {
      const runtime = makeRuntime(ctx);
      const session = await runtime.state.get<SessionHandle>("session");
      if (session) {
        await runtime.step("close", () =>
          new ZedAcpAdapter().close(session),
        );
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
