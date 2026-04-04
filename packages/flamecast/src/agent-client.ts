/**
 * AgentClient — implements acp.Client for downstream agent callbacks.
 *
 * Publishes events to pubsub (session updates, permission requests).
 * Subscribes to pubsub for permission responses from the upstream client.
 * No Restate imports. No ctx. Pure acp.Client.
 */

import * as acp from "@agentclientprotocol/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createPubsubClient } from "@restatedev/pubsub-client";

export class AgentClient implements acp.Client {
  private pending = new Map<string, (outcome: acp.RequestPermissionOutcome) => void>();

  constructor(
    private sessionKey: string,
    private pubsub: ReturnType<typeof createPubsubClient>,
  ) {
    this.startListening();
  }

  async sessionUpdate(params: acp.SessionNotification) {
    this.pubsub.publish(`session:${this.sessionKey}`, {
      type: "session_update",
      sessionUpdate: params.update.sessionUpdate,
      update: params.update,
    }, crypto.randomUUID());
  }

  async requestPermission(params: acp.RequestPermissionRequest) {
    const requestId = crypto.randomUUID();

    this.pubsub.publish(`session:${this.sessionKey}`, {
      type: "permission_request",
      requestId,
      toolCall: params.toolCall,
      options: params.options,
    }, crypto.randomUUID());

    const outcome = await new Promise<acp.RequestPermissionOutcome>((resolve) => {
      this.pending.set(requestId, resolve);
    });
    return { outcome };
  }

  async readTextFile(params: acp.ReadTextFileRequest) {
    return { content: await readFile(params.path, "utf-8") };
  }

  async writeTextFile(params: acp.WriteTextFileRequest) {
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, "utf-8");
    return {};
  }

  private async startListening() {
    for await (const event of this.pubsub.pull({ topic: `session:${this.sessionKey}` })) {
      if (event?.type === "permission_response") {
        this.pending.get(event.requestId)?.(event.outcome);
        this.pending.delete(event.requestId);
      }
    }
  }
}
