/**
 * Flamecast HTTP API — Hono routes.
 *
 * After 5a cleanup:
 * - Template + runtime routes delegate to Flamecast class (in-memory)
 * - Session routes delegate to Restate VOs via ingress
 * - SSE streaming uses Restate pubsub
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import {
  RegisterAgentTemplateBodySchema,
  UpdateAgentTemplateBodySchema,
  createRegisterAgentTemplateBodySchema,
} from "../shared/session.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "listAgentTemplates"
  | "getAgentTemplate"
  | "registerAgentTemplate"
  | "updateAgentTemplate"
  | "listRuntimes"
  | "startRuntime"
  | "stopRuntime"
  | "pauseRuntime"
  | "resolveSessionConfig"
  | "runtimeNames"
  | "restateUrl"
>;

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

function isClientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("unknown agent template") ||
    msg.includes("unknown runtime") ||
    msg.includes("not found")
  );
}

export function createApi(flamecast: FlamecastApi) {
  const [first, ...rest] = flamecast.runtimeNames;
  const registerSchema = first
    ? createRegisterAgentTemplateBodySchema([first, ...rest])
    : RegisterAgentTemplateBodySchema;

  return new Hono()
    .get("/health", (c) => c.json({ status: "ok" }))

    // ── Agent Templates ───────────────────────────────────────────────
    .get("/agent-templates", (c) => {
      return c.json(flamecast.listAgentTemplates());
    })
    .post("/agent-templates", zValidator("json", registerSchema), (c) => {
      try {
        const body = c.req.valid("json");
        const template = flamecast.registerAgentTemplate(body);
        return c.json(template, 201);
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .put("/agent-templates/:id", zValidator("json", UpdateAgentTemplateBodySchema), (c) => {
      try {
        const template = flamecast.updateAgentTemplate(c.req.param("id"), c.req.valid("json"));
        return c.json(template);
      } catch (error) {
        const msg = toErrorMessage(error);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
      }
    })

    // ── Runtime Lifecycle ──────────────────────────────────────────────
    .get("/runtimes", async (c) => {
      try {
        return c.json(await flamecast.listRuntimes());
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .post("/runtimes/:typeName/start", async (c) => {
      try {
        const typeName = c.req.param("typeName");
        const body = await c.req.json().catch(() => ({}));
        const name = body && typeof body === "object" && "name" in body ? body.name : undefined;
        const instance = await flamecast.startRuntime(typeName, name);
        return c.json(instance, 201);
      } catch (error) {
        const msg = toErrorMessage(error);
        return c.json({ error: msg }, isClientError(error) ? 400 : 500);
      }
    })
    .post("/runtimes/:instanceName/stop", async (c) => {
      try {
        await flamecast.stopRuntime(c.req.param("instanceName"));
        return c.json({ ok: true });
      } catch (error) {
        const msg = toErrorMessage(error);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
      }
    })
    .post("/runtimes/:instanceName/pause", async (c) => {
      try {
        await flamecast.pauseRuntime(c.req.param("instanceName"));
        return c.json({ ok: true });
      } catch (error) {
        const msg = toErrorMessage(error);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
      }
    })

    // ── Session routes ────────────────────────────────────────────────
    // Thin proxy: resolves template → calls Restate VO ingress.
    // Other session ops (prompt, cancel, steer, terminate, getStatus)
    // go directly to Restate ingress from the client.
    .post("/sessions", async (c) => {
      try {
        const body = await c.req.json() as {
          agentTemplateId: string;
          cwd?: string;
          runtimeInstance?: string;
        };

        const config = flamecast.resolveSessionConfig({
          agentTemplateId: body.agentTemplateId,
          runtimeInstance: body.runtimeInstance,
        });

        const sessionId = crypto.randomUUID();
        const voName = "ZedAgentSession"; // TODO: route by protocol when IBM templates exist

        const res = await fetch(`${flamecast.restateUrl}/${voName}/${sessionId}/startSession`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: config.spawn.command,
            args: config.spawn.args,
            cwd: body.cwd,
            env: config.runtime.env,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          return c.json({ error: err }, res.status as 400);
        }

        const session = await res.json();
        return c.json({ id: sessionId, ...session }, 201);
      } catch (error) {
        const msg = toErrorMessage(error);
        return c.json({ error: msg }, isClientError(error) ? 404 : 500);
      }
    });
}
