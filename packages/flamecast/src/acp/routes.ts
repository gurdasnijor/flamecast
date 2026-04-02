/**
 * ACP HTTP routes — thin layer mapping ACP OpenAPI spec to Restate VOs.
 *
 *   POST /runs                 →  AcpRun(run_id).execute()
 *   GET  /runs/:id             →  AcpRun(run_id).getStatus()
 *   POST /runs/:id             →  AcpRun(run_id).resume()
 *   POST /runs/:id/cancel      →  AcpRun(run_id).cancel()
 *   GET  /runs/:id/events      →  pubsub.pull("run:{id}") SSE
 */

import { Hono } from "hono";
import * as clients from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { AcpRun } from "./run-vo.js";
import { acpAgents } from "./agent-service.js";

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

    // ── Agents ────────────────────────────────────────────────────────
    .get("/agents", async (c) => {
      const agents = await ingress.serviceClient(acpAgents).listAgents();
      return c.json(agents);
    })

    // ── Runs ──────────────────────────────────────────────────────────

    .post("/runs", async (c) => {
      const body = await c.req.json();
      const runId = crypto.randomUUID();
      const mode = body.mode ?? "async";

      if (mode === "sync") {
        const result = await ingress
          .objectClient(AcpRun, runId)
          .execute({ agentName: body.agentName, prompt: body.prompt });
        return c.json({ id: runId, ...result });
      }

      await ingress
        .objectSendClient(AcpRun, runId)
        .execute({ agentName: body.agentName, prompt: body.prompt });

      return c.json({ id: runId, status: "created" }, 202);
    })

    .get("/runs/:id", async (c) => {
      const runId = c.req.param("id");
      const status = await ingress
        .objectClient(AcpRun, runId)
        .getStatus();
      if (!status) return c.json({ error: "Run not found" }, 404);
      return c.json({ id: runId, ...status });
    })

    .post("/runs/:id", async (c) => {
      const runId = c.req.param("id");
      const body = await c.req.json();
      try {
        const result = await ingress
          .objectClient(AcpRun, runId)
          .resume({ optionId: body.optionId });
        return c.json({ id: runId, ...result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 409);
      }
    })

    .post("/runs/:id/cancel", async (c) => {
      const runId = c.req.param("id");
      try {
        const result = await ingress
          .objectClient(AcpRun, runId)
          .cancel();
        return c.json({ id: runId, ...result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 500);
      }
    })

    // SSE events via Restate pubsub — no polling, durable delivery
    .get("/runs/:id/events", (c) => {
      const runId = c.req.param("id");
      const lastEventId = c.req.header("Last-Event-ID");
      const offset = lastEventId ? parseInt(lastEventId, 10) : undefined;

      const stream = pubsub.sse({
        topic: `run:${runId}`,
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
