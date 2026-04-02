/**
 * RuntimeHost HTTP server — wraps InProcessRuntimeHost for deployed use.
 *
 * Hono server exposing the RuntimeHost interface over HTTP.
 * POST /prompt is non-blocking (202) — the server drives the agent,
 * publishes events to pubsub via typed Restate ingress client, and
 * resolves the VO's awakeable on terminal state.
 *
 * Permission flow: on agent permission request, the server publishes a
 * permission_request event to pubsub and subscribes to the session's
 * event stream for the matching permission_responded event. The API
 * resume route publishes permission_responded when the user responds.
 *
 * Reference: docs/re-arch-unification.md Change 3
 */

import { Hono } from "hono";
import { logger } from "hono/logger";
import * as clients from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { InProcessRuntimeHost } from "./local.js";
import type { AgentSpec, ProcessHandle, PermissionRequest } from "./types.js";
import type { PromptResultPayload } from "@flamecast/protocol/session";

export interface RuntimeHostServerOptions {
  /** Restate ingress URL for awakeable resolution + pubsub. */
  restateIngressUrl: string;
  /** Permission response timeout in ms (default: 5 minutes). */
  permissionTimeoutMs?: number;
}

// ─── Per-session event bus ───────────────────────────────────────────────

type PermissionWaiter = {
  resolve: (decision: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Per-session subscription to pubsub events. Routes permission_responded
 * events to waiting onPermission callbacks. One subscription per session,
 * shared across all concurrent permission requests.
 */
class SessionEventBus {
  private waiters = new Map<string, PermissionWaiter>();
  private controller = new AbortController();

  constructor(
    pubsub: ReturnType<typeof createPubsubClient>,
    sessionId: string,
  ) {
    const messages = pubsub.pull({
      topic: `session:${sessionId}`,
      signal: this.controller.signal,
    });

    // Background listener — routes events to waiters
    (async () => {
      try {
        for await (const msg of messages) {
          const event = msg as {
            type?: string;
            awakeableId?: string;
            decision?: unknown;
          };
          if (
            event.type === "permission_responded" &&
            event.awakeableId
          ) {
            const waiter = this.waiters.get(event.awakeableId);
            if (waiter) {
              this.waiters.delete(event.awakeableId);
              waiter.resolve(event.decision);
            }
          }
        }
      } catch {
        // Stream closed (abort or error) — reject all pending waiters
        for (const [id, waiter] of this.waiters) {
          waiter.reject(new Error("Session event bus closed"));
          this.waiters.delete(id);
        }
      }
    })();
  }

  /** Wait for a permission_responded event matching the given requestId. */
  waitForResponse(requestId: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiters.delete(requestId)) {
          reject(new Error("Permission request timed out"));
        }
      }, timeoutMs);

      this.waiters.set(requestId, {
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  close(): void {
    this.controller.abort();
  }
}

// ─── Server factory ──────────────────────────────────────────────────────

export function createRuntimeHostServer(opts: RuntimeHostServerOptions) {
  const host = new InProcessRuntimeHost();
  const ingress = clients.connect({ url: opts.restateIngressUrl });
  const pubsub = createPubsubClient({
    name: "pubsub",
    ingressUrl: opts.restateIngressUrl,
  });
  const permissionTimeoutMs = opts.permissionTimeoutMs ?? 5 * 60 * 1000;
  const app = new Hono();
  app.use(logger());

  // Per-session event buses for permission flow
  const eventBuses = new Map<string, SessionEventBus>();

  function getOrCreateEventBus(sessionId: string): SessionEventBus {
    let bus = eventBuses.get(sessionId);
    if (!bus) {
      bus = new SessionEventBus(pubsub, sessionId);
      eventBuses.set(sessionId, bus);
    }
    return bus;
  }

  /** Publish an event to the session's pubsub topic. */
  function publishEvent(sessionId: string, event: unknown): void {
    pubsub.publish(`session:${sessionId}`, event).catch(() => {});
  }

  /** Resolve a Restate awakeable with a payload. */
  function resolveAwakeable(awakeableId: string, payload: unknown): void {
    ingress.resolveAwakeable(awakeableId, payload);
  }

  app.post("/sessions/:id/spawn", async (c) => {
    const sessionId = c.req.param("id");
    try {
      const spec = (await c.req.json()) as AgentSpec;
      const handle = await host.spawn(sessionId, spec);
      // Start the event bus for this session (for permission flow)
      getOrCreateEventBus(sessionId);
      return c.json(handle, 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });

  app.post("/sessions/:id/prompt", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json()) as {
      text: string;
      awakeableId?: string;
    };

    if (!host.has(sessionId)) {
      return c.json({ error: "No process for session" }, 404);
    }

    const handle: ProcessHandle = {
      sessionId,
      strategy: "local",
      agentName: "unknown",
    };

    // Fire-and-forget — drive the agent asynchronously
    host
      .prompt(handle, body.text, {
        onEvent(event) {
          publishEvent(sessionId, event);
        },

        async onPermission(request: PermissionRequest) {
          // Generate a unique requestId for this permission exchange
          const requestId = crypto.randomUUID();
          const bus = getOrCreateEventBus(sessionId);

          // Publish permission_request to pubsub → frontend shows dialog
          publishEvent(sessionId, {
            type: "permission_request",
            requestId,
            toolCallId: request.toolCallId,
            title: request.title,
            kind: request.kind,
            options: request.options,
            awakeableId: requestId, // frontend sends this back to /resume
            generation: 0,
          });

          // Block until the user responds (or timeout)
          const decision = (await bus.waitForResponse(
            requestId,
            permissionTimeoutMs,
          )) as { optionId?: string } | undefined;

          return {
            optionId: decision?.optionId ?? request.options[0]?.optionId ?? "approved",
          };
        },

        onComplete(result) {
          if (body.awakeableId) {
            resolveAwakeable(body.awakeableId, result);
          }
          publishEvent(sessionId, { type: "complete", result });
        },

        onError(err) {
          const failResult: PromptResultPayload = {
            status: "failed",
            error: err.message,
            runId: sessionId,
          };
          if (body.awakeableId) {
            resolveAwakeable(body.awakeableId, failResult);
          }
        },
      })
      .catch(() => {});

    return c.json({ accepted: true }, 202);
  });

  app.post("/sessions/:id/cancel", async (c) => {
    const sessionId = c.req.param("id");
    try {
      await host.cancel({
        sessionId,
        strategy: "local",
        agentName: "unknown",
      });
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });

  app.delete("/sessions/:id", async (c) => {
    const sessionId = c.req.param("id");
    try {
      await host.close({
        sessionId,
        strategy: "local",
        agentName: "unknown",
      });
      // Clean up event bus
      const bus = eventBuses.get(sessionId);
      if (bus) {
        bus.close();
        eventBuses.delete(sessionId);
      }
      return c.body(null, 204);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });

  app.get("/sessions/:id/status", (c) => {
    const sessionId = c.req.param("id");
    return c.json({
      sessionId,
      alive: host.has(sessionId),
    });
  });

  return { app, host };
}
