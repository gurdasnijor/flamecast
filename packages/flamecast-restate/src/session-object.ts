import * as restate from "@restatedev/restate-sdk";
import {
  createPubsubObject,
  createPubsubPublisher,
} from "@restatedev/pubsub";
import type { WebhookConfig, WebhookEventType } from "@flamecast/protocol/session";
import { WebhookDeliveryService } from "./webhook-service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  agentName: string;
  hostUrl: string;
  websocketUrl: string;
  runtimeName: string;
  status: "active" | "killed";
  startedAt: string;
  lastUpdatedAt: string;
  spawn: { command: string; args: string[] };
  pendingPermission: unknown | null;
}

export interface StartSessionInput {
  runtimeUrl: string;
  spawn: { command: string; args: string[] };
  cwd: string;
  setup?: string;
  env?: Record<string, string>;
  callbackUrl?: string;
  agentName: string;
  runtimeName: string;
  webhooks?: WebhookConfig[];
}

export interface WaitForInput {
  filter: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ScheduleInput {
  prompt: string;
  delayMs: number;
}

export interface SessionCallbackEvent {
  type: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Pubsub setup
// ---------------------------------------------------------------------------

/** Pubsub object -- must be registered on the Restate endpoint alongside FlamecastSession. */
export const pubsubObject = createPubsubObject("pubsub", {});

/** In-handler publisher (uses ctx.objectSendClient under the hood, journaled). */
const publish = createPubsubPublisher("pubsub");

// ---------------------------------------------------------------------------
// Permission-request helper
// ---------------------------------------------------------------------------

// Durably suspends the VO until the permission is resolved via resolveEvent.
// Zero compute while waiting. The session-host callback blocks until resolution,
// which matches how the Go session-host's RequestPermission already works —
// it holds a channel waiting for the response.
async function handlePermissionRequest(
  ctx: restate.ObjectContext,
  data: unknown,
): Promise<unknown> {
  const { id, promise } = ctx.awakeable<unknown>();
  const now = new Date(await ctx.date.now()).toISOString();

  ctx.set("pending_permission", { awakeableId: id, data });

  // Update meta with pending permission and timestamp
  const meta = await ctx.get<SessionMeta>("meta");
  if (meta) {
    ctx.set("meta", { ...meta, lastUpdatedAt: now, pendingPermission: { ...(data as Record<string, unknown>), awakeableId: id } });
  }

  publish(ctx, `session:${ctx.key}`, {
    type: "permission_request",
    data: { ...(data as Record<string, unknown>), awakeableId: id },
  });

  // Suspend — zero compute. Resolved via resolveEvent handler.
  const response = await promise;

  ctx.clear("pending_permission");
  // Clear pending permission from meta
  const metaAfter = await ctx.get<SessionMeta>("meta");
  if (metaAfter) {
    ctx.set("meta", { ...metaAfter, lastUpdatedAt: new Date(await ctx.date.now()).toISOString(), pendingPermission: null });
  }
  return response;
}

// ---------------------------------------------------------------------------
// FlamecastSession Virtual Object
// ---------------------------------------------------------------------------

export const FlamecastSession = restate.object({
  name: "FlamecastSession",
  handlers: {
    // -----------------------------------------------------------------------
    // Lifecycle (exclusive)
    // -----------------------------------------------------------------------

    start: async (
      ctx: restate.ObjectContext,
      input: StartSessionInput,
    ) => {
      // 1. Forward /start to session-host via runtime URL
      await ctx.run("spawn-agent", async () => {
        const resp = await fetch(
          `${input.runtimeUrl}/sessions/${ctx.key}/start`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: ctx.key,
              command: input.spawn.command,
              args: input.spawn.args,
              workspace: input.cwd,
              setup: input.setup,
              env: input.env,
              callbackUrl: input.callbackUrl,
            }),
          },
        );
        if (!resp.ok) throw new Error(`Session-host /start failed: ${resp.status}`);
        return await resp.json();
      });

      // 2. Persist session state
      // hostUrl and websocketUrl are derived from the runtimeUrl — the Runtime
      // layer (NodeRuntime/DockerRuntime) owns these URLs, and the session-host
      // doesn't return them in its /start response.
      const hostUrl = input.runtimeUrl;
      const websocketUrl = input.runtimeUrl.replace(/^http/, "ws");
      const startedAt = new Date(await ctx.date.now()).toISOString();
      const meta: SessionMeta = {
        id: ctx.key,
        agentName: input.agentName,
        hostUrl,
        websocketUrl,
        runtimeName: input.runtimeName,
        status: "active",
        startedAt,
        lastUpdatedAt: startedAt,
        spawn: input.spawn,
        pendingPermission: null,
      };
      ctx.set("meta", meta);
      ctx.set("webhooks", input.webhooks ?? []);

      // 3. Publish session created event
      publish(ctx, `session:${ctx.key}`, {
        type: "session.created",
        sessionId: ctx.key,
      });

      return {
        sessionId: ctx.key,
        hostUrl,
        websocketUrl,
      };
    },

    terminate: async (ctx: restate.ObjectContext) => {
      const meta = await ctx.get<SessionMeta>("meta");
      if (!meta) return;

      // 1. Forward /terminate to session-host
      await ctx.run("terminate-agent", async () => {
        await fetch(`${meta.hostUrl}/sessions/${ctx.key}/terminate`, {
          method: "POST",
        });
      });

      // 2. Update state
      const now = new Date(await ctx.date.now()).toISOString();
      ctx.set("meta", { ...meta, status: "killed" as const, lastUpdatedAt: now, pendingPermission: null });

      // 3. Publish termination event
      publish(ctx, `session:${ctx.key}`, {
        type: "session.terminated",
        sessionId: ctx.key,
      });
    },

    // -----------------------------------------------------------------------
    // Interaction (exclusive -- automatic serialization)
    // -----------------------------------------------------------------------

    turn: async (
      ctx: restate.ObjectContext,
      input: { text: string },
    ) => {
      const meta = await ctx.get<SessionMeta>("meta");
      if (!meta) throw new restate.TerminalError("Session not found");

      const turnId = ctx.rand.uuidv4();

      // Record turn start in state
      ctx.set("currentTurn", { id: turnId, text: input.text, status: "active" });

      // Fire-and-forget: send prompt to session-host and return immediately.
      // The session-host streams tokens via WebSocket. end_turn and
      // permission_request arrive later via handleCallback. We must NOT
      // block here — that would hold the VO exclusive lock and prevent
      // handleCallback from running (deadlock).
      await ctx.run("send-prompt", async () => {
        const resp = await fetch(
          `${meta.hostUrl}/sessions/${ctx.key}/prompt`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: input.text, turnId }),
          },
        );
        if (!resp.ok) throw new restate.TerminalError(`Prompt failed: ${resp.status}`);
        // Don't await response body — just confirm the prompt was accepted
      });

      return { turnId };
    },

    handleCallback: async (
      ctx: restate.ObjectContext,
      event: SessionCallbackEvent,
    ) => {
      if (event.type === "permission_request") {
        return await handlePermissionRequest(ctx, event.data);
      }
      const now = new Date(await ctx.date.now()).toISOString();
      if (event.type === "session_end") {
        const meta = await ctx.get<SessionMeta>("meta");
        if (meta) ctx.set("meta", { ...meta, status: "killed" as const, lastUpdatedAt: now, pendingPermission: null });
      } else {
        const meta = await ctx.get<SessionMeta>("meta");
        if (meta) ctx.set("meta", { ...meta, lastUpdatedAt: now });
      }
      if (event.type === "end_turn") {
        ctx.set("currentTurn", null);
      }

      // Publish event via pubsub
      publish(ctx, `session:${ctx.key}`, event);

      // Deliver webhooks durably -- fire-and-forget to separate service
      const webhooks =
        (await ctx.get<WebhookConfig[]>("webhooks")) ?? [];
      for (const wh of webhooks) {
        if (wh.events && !wh.events.includes(event.type as WebhookEventType)) continue;
        ctx
          .serviceSendClient(WebhookDeliveryService)
          .deliver({ webhook: wh, sessionId: ctx.key, event });
      }

      return { ok: true };
    },

    // -----------------------------------------------------------------------
    // Temporal primitives (new agent capabilities)
    // -----------------------------------------------------------------------

    waitFor: async (
      ctx: restate.ObjectContext,
      input: WaitForInput,
    ) => {
      const { id, promise } = ctx.awakeable<unknown>();
      ctx.set("waiting_for", { awakeableId: id, filter: input.filter });

      publish(ctx, `session:${ctx.key}`, {
        type: "waiting",
        data: { filter: input.filter, awakeableId: id },
      });

      // Race awakeable against timeout if specified
      let result: unknown;
      if (input.timeoutMs) {
        const timeout = ctx
          .sleep({ milliseconds: input.timeoutMs })
          .map(() => ({ __timeout: true as const }));
        const raceResult = await restate.CombineablePromise.any([
          promise,
          timeout,
        ]);
        if (
          raceResult &&
          typeof raceResult === "object" &&
          "__timeout" in raceResult
        ) {
          ctx.clear("waiting_for");
          throw new restate.TerminalError("Wait timed out");
        }
        result = raceResult;
      } else {
        result = await promise;
      }

      ctx.clear("waiting_for");
      return result;
    },

    // Schedule uses a delayed self-send so the VO is NOT blocked during the delay
    schedule: async (
      ctx: restate.ObjectContext,
      input: ScheduleInput,
    ) => {
      ctx
        .objectSendClient(FlamecastSession, ctx.key)
        .scheduledTurn(
          { prompt: input.prompt },
          restate.rpc.sendOpts({ delay: { milliseconds: input.delayMs } }),
        );
      return { scheduled: true };
    },

    // Separate handler -- executes when the delay fires
    scheduledTurn: async (
      ctx: restate.ObjectContext,
      input: { prompt: string },
    ) => {
      const meta = await ctx.get<SessionMeta>("meta");
      if (!meta || meta.status !== "active") return;

      await ctx.run("scheduled-prompt", async () => {
        await fetch(`${meta.hostUrl}/sessions/${ctx.key}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: input.prompt }),
        });
      });
    },

    resolveEvent: async (
      ctx: restate.ObjectContext,
      input: { awakeableId: string; payload: unknown },
    ) => {
      ctx.resolveAwakeable(input.awakeableId, input.payload);
      return { ok: true };
    },

    // -----------------------------------------------------------------------
    // Queries (shared -- concurrent, non-blocking)
    // -----------------------------------------------------------------------

    getStatus: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext) => {
        return await ctx.get<SessionMeta>("meta");
      },
    ),

    getWebhooks: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext) => {
        return (await ctx.get<WebhookConfig[]>("webhooks")) ?? [];
      },
    ),
  },
});

export type FlamecastSessionApi = typeof FlamecastSession;
