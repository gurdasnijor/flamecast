import * as restate from "@restatedev/restate-sdk";
import { createPubsubObject, createPubsubPublisher } from "@restatedev/pubsub";
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

export interface SessionCallbackEvent {
  type: string;
  data: unknown;
}

/** Typed state keys for the FlamecastSession VO. */
export interface SessionState {
  meta: SessionMeta;
  webhooks: WebhookConfig[];
  currentTurn: { id: string; text: string; status: string } | null;
  pending_permission: { awakeableId: string; data: unknown } | null;
  waiting_for: { awakeableId: string; filter: Record<string, unknown> } | null;
}

// Phase 5 temporal primitive inputs — not yet wired to any code path
export interface WaitForInput {
  filter: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ScheduleInput {
  prompt: string;
  delayMs: number;
}

// ---------------------------------------------------------------------------
// Pubsub
// ---------------------------------------------------------------------------

export const pubsubObject = createPubsubObject("pubsub", {});
const publish = createPubsubPublisher("pubsub");

// ---------------------------------------------------------------------------
// Helpers — extracted from handlers to keep the VO thin
// ---------------------------------------------------------------------------

async function updateMeta(
  ctx: restate.ObjectContext,
  patch: Partial<SessionMeta>,
): Promise<void> {
  const meta = await ctx.get<SessionMeta>("meta");
  if (!meta) return;
  ctx.set("meta", { ...meta, ...patch });
}

async function dispatchWebhooks(
  ctx: restate.ObjectContext,
  sessionId: string,
  event: SessionCallbackEvent,
): Promise<void> {
  const webhooks = (await ctx.get<WebhookConfig[]>("webhooks")) ?? [];
  for (const wh of webhooks) {
    if (wh.events && !wh.events.includes(event.type as WebhookEventType)) continue;
    ctx.serviceSendClient(WebhookDeliveryService).deliver({
      webhook: wh,
      sessionId,
      event,
    });
  }
}

async function handlePermissionRequest(
  ctx: restate.ObjectContext,
  data: unknown,
): Promise<unknown> {
  const { id, promise } = ctx.awakeable<unknown>();
  const now = new Date(await ctx.date.now()).toISOString();
  const permData = { ...(data as Record<string, unknown>), awakeableId: id };

  ctx.set("pending_permission", { awakeableId: id, data });
  await updateMeta(ctx, { lastUpdatedAt: now, pendingPermission: permData });
  publish(ctx, `session:${ctx.key}`, { type: "permission_request", data: permData });

  // Suspend — zero compute until resolved via resolveEvent
  const response = await promise;

  ctx.clear("pending_permission");
  await updateMeta(ctx, {
    lastUpdatedAt: new Date(await ctx.date.now()).toISOString(),
    pendingPermission: null,
  });
  return response;
}

// ---------------------------------------------------------------------------
// FlamecastSession Virtual Object
// ---------------------------------------------------------------------------

export const FlamecastSession = restate.object({
  name: "FlamecastSession",
  handlers: {
    start: async (ctx: restate.ObjectContext, input: StartSessionInput) => {
      await ctx.run("spawn-agent", async () => {
        const resp = await fetch(`${input.runtimeUrl}/sessions/${ctx.key}/start`, {
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
        });
        if (!resp.ok) throw new Error(`Session-host /start failed: ${resp.status}`);
        return await resp.json();
      });

      const hostUrl = input.runtimeUrl;
      const websocketUrl = input.runtimeUrl.replace(/^http/, "ws");
      const startedAt = new Date(await ctx.date.now()).toISOString();
      ctx.set<SessionMeta>("meta", {
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
      });
      ctx.set("webhooks", input.webhooks ?? []);
      publish(ctx, `session:${ctx.key}`, { type: "session.created", sessionId: ctx.key });

      return { sessionId: ctx.key, hostUrl, websocketUrl };
    },

    terminate: async (ctx: restate.ObjectContext) => {
      const meta = await ctx.get<SessionMeta>("meta");
      if (!meta) return;

      await ctx.run("terminate-agent", async () => {
        await fetch(`${meta.hostUrl}/sessions/${ctx.key}/terminate`, { method: "POST" });
      });

      const now = new Date(await ctx.date.now()).toISOString();
      ctx.set("meta", { ...meta, status: "killed" as const, lastUpdatedAt: now, pendingPermission: null });
      publish(ctx, `session:${ctx.key}`, { type: "session.terminated", sessionId: ctx.key });

      // Schedule state cleanup after 7 days
      ctx.objectSendClient(FlamecastSession, ctx.key, { delay: 7 * 24 * 60 * 60 * 1000 }).cleanup();
    },

    handleCallback: async (ctx: restate.ObjectContext, event: SessionCallbackEvent) => {
      if (event.type === "permission_request") {
        return await handlePermissionRequest(ctx, event.data);
      }

      const now = new Date(await ctx.date.now()).toISOString();
      if (event.type === "session_end") {
        await updateMeta(ctx, { status: "killed", lastUpdatedAt: now, pendingPermission: null });
        ctx.objectSendClient(FlamecastSession, ctx.key, { delay: 7 * 24 * 60 * 60 * 1000 }).cleanup();
      } else {
        await updateMeta(ctx, { lastUpdatedAt: now });
      }
      if (event.type === "end_turn") {
        ctx.set("currentTurn", null);
      }

      publish(ctx, `session:${ctx.key}`, event);
      await dispatchWebhooks(ctx, ctx.key, event);
      return { ok: true };
    },

    // Shared handlers — concurrent, non-blocking, lazy state

    sendEvent: restate.handlers.object.shared(
      { enableLazyState: true },
      async (ctx: restate.ObjectSharedContext, event: { awakeableId: string; payload: unknown }) => {
        ctx.resolveAwakeable(event.awakeableId, event.payload);
      },
    ),

    getStatus: restate.handlers.object.shared(
      { enableLazyState: true },
      async (ctx: restate.ObjectSharedContext) => ctx.get<SessionMeta>("meta"),
    ),

    getWebhooks: restate.handlers.object.shared(
      { enableLazyState: true },
      async (ctx: restate.ObjectSharedContext) => (await ctx.get<WebhookConfig[]>("webhooks")) ?? [],
    ),

    cleanup: async (ctx: restate.ObjectContext): Promise<void> => {
      ctx.clearAll();
    },

    // -----------------------------------------------------------------
    // Phase 5 — temporal primitives. Not yet wired to any code path.
    // The Go session-host has dispatch stubs (session/wait_for,
    // session/wait, session/schedule) but no agent exercises them yet.
    // -----------------------------------------------------------------

    waitFor: async (ctx: restate.ObjectContext, input: WaitForInput) => {
      const { id, promise } = ctx.awakeable<unknown>();
      ctx.set("waiting_for", { awakeableId: id, filter: input.filter });
      publish(ctx, `session:${ctx.key}`, { type: "waiting", data: { filter: input.filter, awakeableId: id } });

      let result: unknown;
      if (input.timeoutMs) {
        const timeout = ctx.sleep({ milliseconds: input.timeoutMs }).map(() => ({ __timeout: true as const }));
        const raceResult = await restate.RestatePromise.any([promise, timeout]);
        if (raceResult && typeof raceResult === "object" && "__timeout" in raceResult) {
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

    schedule: async (ctx: restate.ObjectContext, input: ScheduleInput) => {
      ctx.objectSendClient(FlamecastSession, ctx.key).scheduledTurn(
        { prompt: input.prompt },
        restate.rpc.sendOpts({ delay: { milliseconds: input.delayMs } }),
      );
      return { scheduled: true };
    },

    scheduledTurn: async (ctx: restate.ObjectContext, input: { prompt: string }) => {
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
  },
});

export type FlamecastSessionApi = typeof FlamecastSession;
