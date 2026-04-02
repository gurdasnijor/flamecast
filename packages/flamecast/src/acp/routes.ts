/**
 * ACP HTTP routes — maps to AcpSession VO.
 *
 *   POST /sessions              → startSession
 *   GET  /sessions/:id          → getStatus
 *   POST /sessions/:id/prompt   → sendPrompt
 *   POST /sessions/:id/resume   → resumeAgent
 *   POST /sessions/:id/cancel   → terminateSession
 *   GET  /sessions/:id/events   → pubsub SSE
 */

import { Hono } from "hono";
import * as clients from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { AcpSession } from "./session.js";

interface AcpRoutesConfig {
  restateUrl: string;
}

export function createAcpRoutes(config: AcpRoutesConfig) {
  const ingress = clients.connect({ url: config.restateUrl });
  const pubsub = createPubsubClient({
    name: "pubsub",
    ingressUrl: config.restateUrl,
  });

  return new Hono()
    .get("/ping", (c) => c.json({ status: "ok" }))

    // ── Sessions ──────────────────────────────────────────────────────

    .post("/sessions", async (c) => {
      const body = await c.req.json();
      const sessionId = crypto.randomUUID();

      const result = await ingress
        .objectClient(AcpSession, sessionId)
        .startSession({ agentName: body.agentName, cwd: body.cwd });

      return c.json({ id: sessionId, ...result }, 201);
    })

    .get("/sessions/:id", async (c) => {
      const id = c.req.param("id");
      const status = await ingress
        .objectClient(AcpSession, id)
        .getStatus();
      if (!status) return c.json({ error: "Session not found" }, 404);
      return c.json({ id, ...status });
    })

    .post("/sessions/:id/prompt", async (c) => {
      const id = c.req.param("id");
      const body = await c.req.json();
      await ingress
        .objectClient(AcpSession, id)
        .sendPrompt({ text: body.text });
      return c.json({ ok: true });
    })

    .post("/sessions/:id/resume", async (c) => {
      const id = c.req.param("id");
      const body = await c.req.json();
      await ingress
        .objectClient(AcpSession, id)
        .resumeAgent({ awakeableId: body.awakeableId, optionId: body.optionId });
      return c.json({ ok: true });
    })

    .post("/sessions/:id/cancel", async (c) => {
      const id = c.req.param("id");
      await ingress
        .objectClient(AcpSession, id)
        .terminateSession();
      return c.json({ ok: true });
    })

    .get("/sessions/:id/events", (c) => {
      const id = c.req.param("id");
      const lastEventId = c.req.header("Last-Event-ID");
      const offset = lastEventId ? parseInt(lastEventId, 10) : undefined;

      const stream = pubsub.sse({
        topic: `session:${id}`,
        offset: Number.isFinite(offset) ? offset : undefined,
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    });
}
