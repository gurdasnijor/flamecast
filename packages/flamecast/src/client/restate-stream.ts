/**
 * createRestateStream — acp.Stream backed by Restate HTTP + pubsub.
 *
 * Use with the standard SDK ClientSideConnection:
 *
 *   const stream = createRestateStream({ ingressUrl, sessionKey });
 *   const agent = new acp.ClientSideConnection(() => myClient, stream);
 *   await agent.initialize({...});
 *   await agent.prompt({...});
 *
 * Same role as ndJsonStream but for Restate transport instead of stdio pipes.
 */

import * as acp from "@agentclientprotocol/sdk";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk/dist/schema/index.js";
import * as restate from "@restatedev/restate-sdk-clients";
import { createPubsubClient } from "@restatedev/pubsub-client";
import type { AcpAgent as AcpAgentDef } from "../agent.js";

const AcpAgent: typeof AcpAgentDef = { name: "AcpAgent" } as never;

// Map ACP method names → VO handler names
const DISPATCH: Record<string, string> = {
  [AGENT_METHODS.initialize]: "initialize",
  [AGENT_METHODS.session_new]: "newSession",
  [AGENT_METHODS.session_load]: "loadSession",
  [AGENT_METHODS.session_prompt]: "prompt",
  [AGENT_METHODS.session_cancel]: "cancel",
  [AGENT_METHODS.authenticate]: "authenticate",
  [AGENT_METHODS.session_set_mode]: "setSessionMode",
  [AGENT_METHODS.session_set_config_option]: "setSessionConfigOption",
  [AGENT_METHODS.session_list]: "listSessions",
};

// ─── Stream factory ────────────────────────────────────────────────────────

export function createRestateStream(opts: {
  ingressUrl: string;
  sessionKey: string;
  pubsub: ReturnType<typeof createPubsubClient>;
  headers?: Record<string, string>;
}): acp.Stream {
  const { ingressUrl, sessionKey, pubsub, headers } = opts;
  const ingress = restate.connect({ url: ingressUrl, headers });
  const vo = ingress.objectClient(AcpAgent, sessionKey);

  let push: ReadableStreamDefaultController<acp.AnyMessage>;

  const readable = new ReadableStream<acp.AnyMessage>({
    start(controller) {
      push = controller;
      listenPubsub(pubsub, sessionKey, controller);
    },
  });

  const writable = new WritableStream<acp.AnyMessage>({
    async write(message: acp.AnyMessage) {
      const msg = message as Record<string, unknown>;

      if ("method" in msg && "id" in msg) {
        const handler = DISPATCH[msg.method as string];
        if (!handler) throw new Error(`Unknown ACP method: ${msg.method}`);
        const result = await (vo as any)[handler](msg.params);
        push.enqueue({ jsonrpc: "2.0", id: msg.id, result } as acp.AnyMessage);

      } else if ("method" in msg) {
        const handler = DISPATCH[msg.method as string];
        if (handler) await (vo as any)[handler](msg.params);

      } else if ("id" in msg) {
        pubsub.publish(`session:${sessionKey}`, {
          type: "permission_response",
          requestId: msg.id,
          outcome: (msg as any).result,
        }, crypto.randomUUID());
      }
    },
  });

  return { readable, writable };
}

// ─── Pubsub listener ───────────────────────────────────────────────────────

async function listenPubsub(
  pubsub: ReturnType<typeof createPubsubClient>,
  sessionKey: string,
  controller: ReadableStreamDefaultController<acp.AnyMessage>,
) {
  try {
    for await (const event of pubsub.pull({ topic: `session:${sessionKey}` })) {
      if (event?.type === "session_update") {
        controller.enqueue({
          jsonrpc: "2.0",
          method: CLIENT_METHODS.session_update,
          params: { sessionId: sessionKey, update: event.update },
        } as acp.AnyMessage);
      }

      if (event?.type === "permission_request") {
        controller.enqueue({
          jsonrpc: "2.0",
          id: event.requestId,
          method: CLIENT_METHODS.session_request_permission,
          params: {
            sessionId: sessionKey,
            toolCall: event.toolCall,
            options: event.options,
          },
        } as acp.AnyMessage);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      console.error("[createRestateStream] pubsub error:", err);
    }
  }
}
