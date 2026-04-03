/**
 * AcpSession — Restate Virtual Object for multi-turn agent sessions.
 *
 * Handler names match the ACP spec:
 *   newSession  → initialize + session/new (exclusive, blocking)
 *   prompt      → session/prompt (exclusive, blocking per turn)
 *   cancel      → session/cancel (shared)
 *   getStatus   → query session metadata (shared)
 *   resumePermission → resolve permission request (shared)
 *   close       → terminate session (shared)
 */

import * as restate from "@restatedev/restate-sdk";
import * as acp from "@agentclientprotocol/sdk";
import {
  zNewSessionRequest,
  zNewSessionResponse,
  zPromptRequest,
  zPromptResponse,
  zRequestPermissionResponse,
  zSessionInfo,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createPubsubClient } from "@restatedev/pubsub-client";
import type { AgentConnectionFactory } from "@flamecast/acp";
import { RegistryConnectionFactory } from "@flamecast/acp/resolver";

// ─── Agent connection factory (injectable for tests) ────────────────────────

const agentIds = (process.env.ACP_AGENTS ?? "claude-acp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let factory: AgentConnectionFactory = new RegistryConnectionFactory(agentIds);

let pubsub = createPubsubClient({
  name: "pubsub",
  ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080",
});

/**
 * Configure the ACP connection factory and optionally the ingress URL.
 * Call before endpoint registration. Tests use this to inject fixtures.
 */
export function configureAcp(
  f: AgentConnectionFactory,
  opts?: { ingressUrl?: string },
) {
  factory = f;
  if (opts?.ingressUrl) {
    pubsub = createPubsubClient({
      name: "pubsub",
      ingressUrl: opts.ingressUrl,
    });
  }
}

function emit(ctx: restate.ObjectContext, event: Record<string, unknown>) {
  pubsub.publish(`session:${ctx.key}`, event, ctx.rand.uuidv4());
}

// ─── ACP Client implementation ──────────────────────────────────────────────

/**
 * Flamecast's acp.Client — handles agent→client callbacks.
 */
class FlamecastClient implements acp.Client {
  constructor(private ctx: restate.ObjectContext) {}

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    emit(this.ctx, {
      type: "session_update",
      sessionUpdate: params.update.sessionUpdate,
      update: params.update,
    });
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const { id: awakeableId, promise } =
      this.ctx.awakeable<acp.RequestPermissionOutcome>();

    emit(this.ctx, {
      type: "permission_request",
      toolCall: params.toolCall,
      options: params.options,
      awakeableId,
    });

    return { outcome: await promise };
  }

  async readTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    return { content: await readFile(params.path, "utf-8") };
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, "utf-8");
    return {};
  }
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const ResumePermissionInput = z.object({
  awakeableId: z.string(),
  optionId: z.string().optional(),
  outcome: z.enum(["selected", "cancelled"]).default("selected"),
});

export type SessionState = acp.SessionInfo;

// ─── Virtual Object ─────────────────────────────────────────────────────────

export const AcpSession = restate.object({
  name: "AcpSession",
  handlers: {
    newSession: restate.handlers.object.exclusive(
      {
        input: restate.serde.schema(zNewSessionRequest),
        output: restate.serde.schema(zNewSessionResponse),
      },
      async (
        ctx: restate.ObjectContext,
        input: acp.NewSessionRequest,
      ): Promise<acp.NewSessionResponse> => {
        const sessionId = ctx.key;
        const agentName = (input._meta?.agentName as string) ?? "claude-acp";
        const client = new FlamecastClient(ctx);

        // Connect (pool handles initialize, we do newSession)
        const { conn } = await factory.connect(agentName, client);
        const session = await conn.newSession({
          cwd: input.cwd,
          mcpServers: input.mcpServers,
        });

        ctx.set("meta", { sessionId, cwd: input.cwd } satisfies SessionState);
        ctx.set("agentName", agentName);
        ctx.set("acpSessionId", session.sessionId);

        emit(ctx, { type: "session.created", sessionId });

        return { sessionId };
      },
    ),

    prompt: restate.handlers.object.exclusive(
      {
        input: restate.serde.schema(zPromptRequest),
        output: restate.serde.schema(zPromptResponse),
      },
      async (
        ctx: restate.ObjectContext,
        input: acp.PromptRequest,
      ): Promise<acp.PromptResponse> => {
        const agentName = await ctx.get<string>("agentName");
        const acpSessionId = await ctx.get<string>("acpSessionId");
        if (!agentName || !acpSessionId) {
          throw new restate.TerminalError(
            "No active session — call newSession first",
          );
        }

        const client = new FlamecastClient(ctx);

        // Pool swaps the active client to this handler's context
        const { conn } = await factory.connect(agentName, client);

        const text = input.prompt
          .filter(
            (b): b is { type: "text"; text: string } => b.type === "text",
          )
          .map((b) => b.text)
          .join("\n");

        try {
          const result = await conn.prompt({
            sessionId: acpSessionId,
            prompt: [{ type: "text", text }],
          });

          emit(ctx, {
            type: "prompt_complete",
            stopReason: result.stopReason,
          });

          const meta = await ctx.get<SessionState>("meta");
          if (meta) {
            meta.updatedAt = await ctx.date.toJSON();
            ctx.set("meta", meta);
          }

          return result;
        } catch (err) {
          const errorMsg =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err !== null
                ? JSON.stringify(err)
                : String(err);
          emit(ctx, {
            type: "prompt_failed",
            error: errorMsg,
          });
          throw new restate.TerminalError(errorMsg);
        }
      },
    ),

    cancel: restate.handlers.object.shared(
      {
        output: restate.serde.schema(z.object({ cancelled: z.boolean() })),
      },
      async (_ctx: restate.ObjectSharedContext) => {
        // TODO: need in-flight connection reference to cancel
        return { cancelled: false };
      },
    ),

    getStatus: restate.handlers.object.shared(
      {
        output: restate.serde.schema(zSessionInfo.nullable()),
      },
      async (ctx: restate.ObjectSharedContext): Promise<SessionState | null> => {
        return ctx.get<SessionState>("meta");
      },
    ),

    resumePermission: restate.handlers.object.shared(
      {
        input: restate.serde.schema(ResumePermissionInput),
        output: restate.serde.schema(zRequestPermissionResponse),
      },
      async (
        ctx: restate.ObjectSharedContext,
        input: z.infer<typeof ResumePermissionInput>,
      ): Promise<acp.RequestPermissionResponse> => {
        const outcome: acp.RequestPermissionOutcome =
          input.outcome === "cancelled"
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: input.optionId! };

        ctx.resolveAwakeable(input.awakeableId, outcome);
        return { outcome };
      },
    ),

    close: restate.handlers.object.shared(
      {
        output: restate.serde.schema(zPromptResponse),
      },
      async (_ctx: restate.ObjectSharedContext): Promise<acp.PromptResponse> => {
        return { stopReason: "cancelled" };
      },
    ),
  },
});
