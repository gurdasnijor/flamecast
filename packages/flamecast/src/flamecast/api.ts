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
import { createPubsubClient } from "@restatedev/pubsub-client";

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
    .get("/sessions", async (c) => {
      try {
        // Derive admin URL from ingress URL (18080 → 19070)
        const adminUrl = flamecast.restateUrl.replace(/:\d+$/, ":19070");
        const sessions: Record<string, unknown>[] = [];

        for (const service of ["ZedAgentSession", "IbmAgentSession"]) {
          const res = await fetch(`${adminUrl}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `SELECT service_key, value FROM state WHERE service_name = '${service}' AND key = 'meta'`,
            }),
          });
          if (!res.ok) continue;
          const body = await res.json() as { rows?: string[][] };
          if (!body.rows) continue;
          for (const [serviceKey, hexValue] of body.rows) {
            try {
              const json = Buffer.from(hexValue, "hex").toString("utf8");
              const meta = JSON.parse(json);
              sessions.push({ id: serviceKey, ...meta });
            } catch {
              // skip malformed entries
            }
          }
        }

        return c.json(sessions);
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
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
            cwd: body.cwd ?? process.cwd(),
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
    })
    .get("/sessions/:id", async (c) => {
      const sessionId = c.req.param("id");
      // Try both VO types — one will have the session
      for (const voName of ["ZedAgentSession", "IbmAgentSession"]) {
        try {
          const res = await fetch(`${flamecast.restateUrl}/${voName}/${sessionId}/getStatus`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (res.ok) {
            const meta = await res.json();
            if (meta) return c.json({ id: sessionId, ...meta });
          }
        } catch {
          // Try next VO type
        }
      }
      return c.json({ error: "Session not found" }, 404);
    })
    .post("/sessions/:id/prompt", async (c) => {
      const sessionId = c.req.param("id");
      try {
        const body = await c.req.json() as { text: string };
        const res = await fetch(
          `${flamecast.restateUrl}/ZedAgentSession/${sessionId}/runAgent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: body.text }),
          },
        );
        if (!res.ok) {
          const err = await res.text();
          return c.json({ error: err }, res.status as 400);
        }
        return c.json(await res.json());
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .post("/sessions/:id/cancel", async (c) => {
      const sessionId = c.req.param("id");
      try {
        const res = await fetch(
          `${flamecast.restateUrl}/ZedAgentSession/${sessionId}/cancelAgent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        if (!res.ok) {
          const err = await res.text();
          return c.json({ error: err }, res.status as 400);
        }
        return c.json(await res.json());
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .get("/sessions/:id/fs", async (c) => {
      const sessionId = c.req.param("id");
      try {
        const statusRes = await fetch(
          `${flamecast.restateUrl}/ZedAgentSession/${sessionId}/getStatus`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        if (!statusRes.ok) return c.json({ error: "Session not found" }, 404);
        const status = await statusRes.json() as { cwd?: string };
        if (!status?.cwd) return c.json({ error: "No cwd for session" }, 400);

        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(status.cwd, { withFileTypes: true });
        return c.json({
          root: status.cwd,
          entries: entries.map((d) => ({
            path: d.name,
            type: d.isDirectory() ? "directory" : d.isFile() ? "file" : "other",
          })),
        });
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .get("/sessions/:id/files", async (c) => {
      const sessionId = c.req.param("id");
      const reqPath = c.req.query("path");
      if (!reqPath) return c.json({ error: "Missing ?path= parameter" }, 400);

      try {
        const statusRes = await fetch(
          `${flamecast.restateUrl}/ZedAgentSession/${sessionId}/getStatus`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        if (!statusRes.ok) return c.json({ error: "Session not found" }, 404);
        const status = await statusRes.json() as { cwd?: string };
        if (!status?.cwd) return c.json({ error: "No cwd for session" }, 400);

        const path = await import("node:path");
        // Validate path doesn't escape cwd
        if (reqPath.includes("\0") || path.isAbsolute(reqPath)) {
          return c.json({ error: "Invalid path" }, 400);
        }
        const resolved = path.resolve(status.cwd, reqPath);
        const rel = path.relative(status.cwd, resolved);
        if (rel.startsWith("..")) {
          return c.json({ error: "Path outside workspace" }, 403);
        }

        const { readFile } = await import("node:fs/promises");
        const content = await readFile(resolved, "utf8");
        return c.json({ path: reqPath, content });
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .get("/sessions/:id/events", (c) => {
      const sessionId = c.req.param("id");
      const lastEventId = c.req.header("Last-Event-ID");
      const offset = lastEventId ? parseInt(lastEventId, 10) : undefined;
      const client = createPubsubClient({
        name: "pubsub",
        ingressUrl: flamecast.restateUrl,
      });
      const stream = client.sse({
        topic: `session:${sessionId}`,
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
