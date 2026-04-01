/**
 * RuntimeHost HTTP server — wraps InProcessRuntimeHost for deployed use.
 *
 * Hono server exposing the RuntimeHost interface over HTTP.
 * POST /prompt is non-blocking (202) — the server drives the agent,
 * publishes events to pubsub via Restate ingress, and resolves the
 * VO's awakeable on terminal state.
 *
 * Only needed for deployed/multi-tenant. Local dev uses
 * InProcessRuntimeHost directly (no HTTP overhead).
 *
 * Reference: docs/re-arch-unification.md Change 3
 */

import { Hono } from "hono";
import { InProcessRuntimeHost } from "./local.js";
import type { AgentSpec, ProcessHandle } from "./types.js";
import type { PromptResultPayload } from "@flamecast/protocol/session";

export interface RuntimeHostServerOptions {
  /** Restate ingress URL for awakeable resolution + pubsub. */
  restateIngressUrl: string;
}

export function createRuntimeHostServer(opts: RuntimeHostServerOptions) {
  const host = new InProcessRuntimeHost();
  const app = new Hono();

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
          // Publish streaming events to pubsub via Restate ingress
          fetch(
            `${opts.restateIngressUrl}/pubsub/session:${sessionId}/publish`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(event),
            },
          ).catch(() => {});
        },

        async onPermission(request) {
          // Call VO's requestPermission shared handler
          // For now, auto-approve (the full mechanism uses SSE subscription)
          return { optionId: request.options[0]?.optionId ?? "approved" };
        },

        onComplete(result) {
          // Resolve the VO's awakeable if provided
          if (body.awakeableId) {
            fetch(
              `${opts.restateIngressUrl}/restate/awakeables/${body.awakeableId}/resolve`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(result),
              },
            ).catch(() => {});
          }
          // Also publish complete event
          fetch(
            `${opts.restateIngressUrl}/pubsub/session:${sessionId}/publish`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "complete", result }),
            },
          ).catch(() => {});
        },

        onError(err) {
          const failResult: PromptResultPayload = {
            status: "failed",
            error: err.message,
            runId: sessionId,
          };
          if (body.awakeableId) {
            fetch(
              `${opts.restateIngressUrl}/restate/awakeables/${body.awakeableId}/resolve`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(failResult),
              },
            ).catch(() => {});
          }
        },
      })
      .catch(() => {});

    // Return 202 immediately — agent runs asynchronously
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
