/**
 * Flamecast HTTP API — Hono routes.
 *
 * - Template + runtime routes delegate to Flamecast class (in-memory)
 * - Session routes use typed Restate ingress client (@restatedev/restate-sdk-clients)
 * - SSE streaming uses Restate pubsub
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as clients from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";
import type { Flamecast } from "./flamecast-class.js";

// Lightweight client reference — avoids importing the full VO definition
// (which pulls in Restate SDK server, child_process, RuntimeHost, etc.)
// The ingress client only needs { name } to route calls; handler types
// are inferred as `any` — the actual type safety lives on the VO side.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AgentSession: any = { name: "AgentSession" };

// ─── Zod schemas for API input validation ─────────────────────────────────

const AgentSpawnSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

const AgentTemplateRuntimeSchema = z.object({
  provider: z.string().min(1),
  image: z.string().optional(),
  dockerfile: z.string().optional(),
  setup: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const RegisterAgentTemplateBodySchema = z.object({
  name: z.string().min(1),
  spawn: AgentSpawnSchema,
  runtime: AgentTemplateRuntimeSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const UpdateAgentTemplateBodySchema = z.object({
  name: z.string().min(1).optional(),
  spawn: AgentSpawnSchema.optional(),
  runtime: AgentTemplateRuntimeSchema.partial().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type FlamecastApi = Pick<
  Flamecast,
  | "listAgentTemplates"
  | "getAgentTemplate"
  | "registerAgentTemplate"
  | "updateAgentTemplate"
  | "resolveSessionConfig"
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

  // Typed Restate ingress client — used for all VO calls
  const ingress = clients.connect({ url: flamecast.restateUrl });

  return new Hono()
    .get("/health", (c) => c.json({ status: "ok" }))

    // ── Agent Templates ───────────────────────────────────────────────
    .get("/agent-templates", (c) => {
      return c.json(flamecast.listAgentTemplates());
    })
    .post("/agent-templates", zValidator("json", RegisterAgentTemplateBodySchema), (c) => {
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

    // ── Session routes (typed Restate ingress client) ─────────────────
    .get("/sessions", async (c) => {
      try {
        const adminUrl = flamecast.restateUrl.replace(/:\d+$/, ":19070");
        const sessions: Record<string, unknown>[] = [];

        for (const service of ["AgentSession"]) {
          const res = await fetch(`${adminUrl}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              query: `SELECT service_key, value FROM state WHERE service_name = '${service}' AND key = 'meta'`,
            }),
          });
          if (!res.ok) continue;
          const body = await res.json() as { rows?: Record<string, string>[] };
          if (!body.rows) continue;
          for (const row of body.rows) {
            try {
              const json = Buffer.from(row.value, "hex").toString("utf8");
              const meta = JSON.parse(json);
              sessions.push({ id: row.service_key, ...meta });
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
        };

        const config = flamecast.resolveSessionConfig({
          agentTemplateId: body.agentTemplateId,
        });

        const sessionId = crypto.randomUUID();
        const session = await ingress
          .objectClient(AgentSession, sessionId)
          .startSession({
            agent: config.spawn.command,
            args: config.spawn.args,
            cwd: body.cwd ?? process.cwd(),
            env: config.runtime.env,
            strategy: config.runtime.provider === "docker" ? "docker" : "local",
            containerImage: config.runtime.image,
          });

        return c.json({ id: sessionId, ...(session as Record<string, unknown>) }, 201);
      } catch (error) {
        const msg = toErrorMessage(error);
        return c.json({ error: msg }, isClientError(error) ? 404 : 500);
      }
    })
    .get("/sessions/:id", async (c) => {
      const sessionId = c.req.param("id");
      
      try {
        const meta = await ingress
          .objectClient(AgentSession, sessionId)
          .getStatus();
        if (meta) return c.json({ id: sessionId, ...meta });
        return c.json({ error: "Session not found" }, 404);
      } catch {
        return c.json({ error: "Session not found" }, 404);
      }
    })
    .post("/sessions/:id/prompt", async (c) => {
      const sessionId = c.req.param("id");
      try {
        const { text } = await c.req.json() as { text: string };
        // Always use sendPrompt — the conversation loop is started
        // by startSession and is always suspended waiting for a prompt.
        await ingress
          .objectClient(AgentSession, sessionId)
          .sendPrompt({ text });
        return c.json({ ok: true });
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .post("/sessions/:id/resume", async (c) => {
      const sessionId = c.req.param("id");
      try {
        const body = await c.req.json() as {
          awakeableId: string;
          payload: unknown;
        };

        // Two paths depending on where the permission originated:
        //
        // 1. Inprocess: awakeableId is a real Restate awakeable created by
        //    the VO's conversationLoop. resolveAwakeable unblocks it directly.
        //
        // 2. Remote: awakeableId is a server-generated requestId. The
        //    RuntimeHost server holds a local Promise keyed by this ID.
        //    Call its /permissions/:requestId/respond endpoint to resolve it.

        // Try resolving as Restate awakeable (inprocess path)
        try {
          await ingress.resolveAwakeable(body.awakeableId, body.payload);
        } catch (err) {
          // 404 = not a real Restate awakeable → try RuntimeHost endpoint
          // Other errors (network, Restate down) should be logged
          console.warn(`[resume] resolveAwakeable failed for ${body.awakeableId}:`, err instanceof Error ? err.message : err);
          const runtimeHostUrl = process.env.FLAMECAST_RUNTIME_HOST_URL;
          if (runtimeHostUrl) {
            await fetch(
              `${runtimeHostUrl}/sessions/${sessionId}/permissions/${body.awakeableId}/respond`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body.payload),
              },
            ).catch(() => {});
          }
        }

        return c.json({ ok: true });
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .post("/sessions/:id/cancel", async (c) => {
      const sessionId = c.req.param("id");
      try {
        const result = await ingress
          .objectClient(AgentSession, sessionId)
          .cancelAgent();
        return c.json(result);
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .get("/sessions/:id/fs", async (c) => {
      const sessionId = c.req.param("id");
      try {
        const status = await ingress
          .objectClient(AgentSession, sessionId)
          .getStatus() as { cwd?: string } | null;
        if (!status?.cwd) return c.json({ error: "No cwd for session" }, 400);

        const { readdir } = await import("node:fs/promises");
        const path = await import("node:path");
        type Entry = { path: string; type: "file" | "directory" | "other" };
        const entries: Entry[] = [];
        const walk = async (dir: string): Promise<void> => {
          const dirents = await readdir(dir, { withFileTypes: true }).catch(() => null);
          if (!dirents) return;
          for (const d of dirents) {
            const full = path.join(dir, d.name);
            const rel = path.relative(status.cwd!, full).split(path.sep).join("/");
            if (d.isDirectory()) {
              entries.push({ path: rel, type: "directory" });
              await walk(full);
            } else {
              entries.push({ path: rel, type: d.isFile() ? "file" : "other" });
            }
          }
        };
        await walk(status.cwd);
        return c.json({
          root: status.cwd,
          entries: entries.slice(0, 10_000),
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
        const status = await ingress
          .objectClient(AgentSession, sessionId)
          .getStatus() as { cwd?: string } | null;
        if (!status?.cwd) return c.json({ error: "No cwd for session" }, 400);

        const path = await import("node:path");
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
      const pubsub = createPubsubClient({
        name: "pubsub",
        ingressUrl: flamecast.restateUrl,
      });

      // Manual SSE frames with id: for Last-Event-ID replay
      const encoder = new TextEncoder();
      const messages = pubsub.pull({
        topic: `session:${sessionId}`,
        offset: Number.isFinite(offset) ? offset : undefined,
      });
      let seq = offset ?? 0;
      const stream = new ReadableStream({
        async start(controller) {
          try {
            controller.enqueue(encoder.encode("event: ping\n\n"));
            for await (const message of messages) {
              seq++;
              const frame = `id: ${seq}\ndata: ${JSON.stringify(message)}\n\n`;
              controller.enqueue(encoder.encode(frame));
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    })

    // ── Agent-to-agent delegation ─────────────────────────────────────
    .post("/sessions/:id/delegate", async (c) => {
      const parentId = c.req.param("id");
      try {
        const body = await c.req.json() as {
          agentTemplateId: string;
          text: string;
          cwd?: string;
        };

        const config = flamecast.resolveSessionConfig({
          agentTemplateId: body.agentTemplateId,
        });

        const childId = crypto.randomUUID();

        // Start child session via typed client
        await ingress
          .objectClient(AgentSession, childId)
          .startSession({
            agent: config.spawn.command,
            args: config.spawn.args,
            cwd: body.cwd ?? process.cwd(),
            env: config.runtime.env,
            strategy: config.runtime.provider === "docker" ? "docker" : "local",
            containerImage: config.runtime.image,
          });

        // Send the first prompt to the child (conversation loop already started)
        await ingress
          .objectClient(AgentSession, childId)
          .sendPrompt({ text: body.text });

        return c.json({ parentId, childId }, 201);
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    });
}
