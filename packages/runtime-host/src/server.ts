/**
 * RuntimeHost HTTP server — wraps InProcessRuntimeHost for deployed use.
 *
 * Hono server exposing the RuntimeHost interface over HTTP.
 * POST /prompt is non-blocking (202) — the server drives the agent,
 * publishes events to pubsub via typed Restate ingress client, and
 * resolves the VO's awakeable on terminal state.
 *
 * Only needed for deployed/multi-tenant. Local dev uses
 * InProcessRuntimeHost directly (no HTTP overhead).
 *
 * Reference: docs/re-arch-unification.md Change 3
 */

import { Hono } from "hono";
import * as clients from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { InProcessRuntimeHost } from "./local.js";
import type { AgentSpec, ProcessHandle } from "./types.js";
import type { PromptResultPayload } from "@flamecast/protocol/session";

export interface RuntimeHostServerOptions {
  /** Restate ingress URL for awakeable resolution + pubsub. */
  restateIngressUrl: string;
}

export function createRuntimeHostServer(opts: RuntimeHostServerOptions) {
  const host = new InProcessRuntimeHost();
  const ingress = clients.connect({ url: opts.restateIngressUrl });
  const pubsub = createPubsubClient({
    name: "pubsub",
    ingressUrl: opts.restateIngressUrl,
  });
  const app = new Hono();

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

        async onPermission(request) {
          // TODO: call VO requestPermission handler + SSE subscription
          return { optionId: request.options[0]?.optionId ?? "approved" };
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
