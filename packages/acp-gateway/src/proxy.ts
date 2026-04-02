/**
 * ACP Gateway — Hono HTTP app exposing ACP REST API over stdio agent processes.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SpawnConfig } from "./registry.js";
import {
  spawnForRun,
  executeRun,
  getProcess,
  cancelRun,
  killProcess,
} from "./spawner.js";
import {
  messagesToText,
  textToMessages,
  type Message,
  type RunStatus,
} from "./bridge.js";

interface RunResponse {
  id: string;
  agentName: string;
  status: RunStatus;
  output?: Message[];
  error?: string;
  awaitRequest?: unknown;
}

function runToResponse(runId: string): RunResponse | null {
  const p = getProcess(runId);
  if (!p) return null;
  return {
    id: p.runId,
    agentName: p.agentId,
    status: p.status,
    output: p.output ? textToMessages(p.output.map((o) => o.parts.map((pt) => pt.content).join("")).join(""), "agent") : undefined,
    error: p.error,
    awaitRequest: p.permissionRequest,
  };
}

export function createProxy(configs: SpawnConfig[]) {
  const configMap = new Map(configs.map((c) => [c.id, c]));
  // Also index by manifest name for agent_name lookups
  for (const c of configs) {
    configMap.set(c.manifest.name, c);
  }

  // Track completed runs that no longer have live processes
  const completedRuns = new Map<string, RunResponse>();

  const app = new Hono();

  // ── Health ──────────────────────────────────────────────────────────────
  app.get("/ping", (c) => c.json({ status: "ok" }));

  // ── Agents ──────────────────────────────────────────────────────────────
  app.get("/agents", (c) => {
    const agents = configs.map((config) => ({
      name: config.id,
      description: config.manifest.description,
      metadata: {
        version: config.manifest.version,
        icon: config.manifest.icon,
        distribution: config.distribution.type,
      },
    }));
    return c.json(agents);
  });

  app.get("/agents/:name", (c) => {
    const name = c.req.param("name");
    const config = configMap.get(name);
    if (!config) return c.json({ error: "Agent not found" }, 404);
    return c.json({
      name: config.id,
      description: config.manifest.description,
      metadata: {
        version: config.manifest.version,
        icon: config.manifest.icon,
        distribution: config.distribution.type,
      },
    });
  });

  // ── Create Run ──────────────────────────────────────────────────────────
  app.post("/runs", async (c) => {
    const body = (await c.req.json()) as {
      agentName: string;
      input: Array<{ role?: string; parts: Array<Record<string, unknown>> }>;
      mode?: "sync" | "async" | "stream";
      sessionId?: string;
    };

    const config = configMap.get(body.agentName);
    if (!config) {
      return c.json({ error: `Unknown agent: ${body.agentName}` }, 404);
    }

    const promptText = messagesToText(body.input);
    if (!promptText) {
      return c.json({ error: "No text content in input messages" }, 400);
    }

    const runId = crypto.randomUUID();
    const mode = body.mode ?? "async";

    // Spawn agent process
    let agentProcess;
    try {
      agentProcess = await spawnForRun(runId, config);
    } catch (err) {
      return c.json(
        {
          error: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }

    // Store completed runs when process finishes
    const storeCompleted = () => {
      agentProcess.emitter.on("event", (event: { type: string }) => {
        if (
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled"
        ) {
          const response = runToResponse(runId);
          if (response) {
            completedRuns.set(runId, { ...response });
          }
        }
      });
    };

    if (mode === "sync") {
      // Block until run completes
      storeCompleted();
      await executeRun(agentProcess, promptText);
      const response = runToResponse(runId) ?? completedRuns.get(runId);
      killProcess(runId);
      return c.json(response);
    }

    if (mode === "stream") {
      // Subscribe BEFORE executeRun to avoid losing early events
      storeCompleted();

      return streamSSE(c, async (stream) => {
        // Set up listener first
        const done = new Promise<void>((resolve) => {
          const onEvent = (event: Record<string, unknown>) => {
            stream
              .writeSSE({ data: JSON.stringify(event) })
              .catch(() => {
                agentProcess.emitter.off("event", onEvent);
                resolve();
              });

            const type = event.type as string;
            if (
              type === "run.completed" ||
              type === "run.failed" ||
              type === "run.cancelled"
            ) {
              agentProcess.emitter.off("event", onEvent);
              resolve();
            }
          };
          agentProcess.emitter.on("event", onEvent);
        });

        // Now start execution — events will be caught by listener above
        executeRun(agentProcess, promptText).then(() => killProcess(runId));

        await done;
      });
    }

    // async mode — fire and forget
    storeCompleted();
    executeRun(agentProcess, promptText).then(() => killProcess(runId));

    return c.json(
      {
        id: runId,
        agentName: config.id,
        status: "created",
      },
      202,
    );
  });

  // ── Get Run Status ──────────────────────────────────────────────────────
  app.get("/runs/:id", (c) => {
    const runId = c.req.param("id");
    const response = runToResponse(runId) ?? completedRuns.get(runId);
    if (!response) return c.json({ error: "Run not found" }, 404);
    return c.json(response);
  });

  // ── Cancel Run ──────────────────────────────────────────────────────────
  app.post("/runs/:id/cancel", async (c) => {
    const runId = c.req.param("id");
    const cancelled = await cancelRun(runId);
    if (!cancelled) return c.json({ error: "Run not found" }, 404);
    return c.json({ id: runId, status: "cancelled" });
  });

  // ── Resume Run (awaiting → in-progress) ─────────────────────────────────
  app.post("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const p = getProcess(runId);
    if (!p) return c.json({ error: "Run not found" }, 404);
    if (p.status !== "awaiting" || !p.resolvePermission) {
      return c.json({ error: "Run is not awaiting input" }, 409);
    }

    const body = (await c.req.json()) as {
      input?: Array<Record<string, unknown>>;
      optionId?: string;
    };

    // Resolve the permission with optionId
    const optionId =
      body.optionId ?? p.permissionRequest?.options[0]?.optionId;
    if (!optionId) {
      return c.json({ error: "No optionId provided" }, 400);
    }

    p.resolvePermission({ optionId });
    return c.json({ id: runId, status: "in-progress" });
  });

  // ── SSE Events ──────────────────────────────────────────────────────────
  app.get("/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    const p = getProcess(runId);
    if (!p) return c.json({ error: "Run not found" }, 404);

    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const onEvent = (event: Record<string, unknown>) => {
          stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
            p.emitter.off("event", onEvent);
            resolve();
          });

          const type = event.type as string;
          if (
            type === "run.completed" ||
            type === "run.failed" ||
            type === "run.cancelled"
          ) {
            p.emitter.off("event", onEvent);
            resolve();
          }
        };
        p.emitter.on("event", onEvent);
      });
    });
  });

  return app;
}
