/**
 * IBM ACP (Agent Communication Protocol) adapter — SDK-based REST.
 *
 * Implements the IbmAcpAdapterInterface for communicating with IBM ACP agents
 * using the official acp-sdk package. The VO uses createRun + awakeable pattern
 * for durable orchestration; promptSync/awaitRun is provided for simple callers.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §2.3
 */

import { Client, type Run, type Event, type AwaitResume } from "acp-sdk";
import type {
  AgentEvent,
  AgentMessage,
  AgentStartConfig,
  ConfigOption,
  IbmAcpAdapterInterface,
  PromptResult,
  SessionHandle,
} from "./adapter.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function toInput(input: string | AgentMessage[]): string {
  if (typeof input === "string") return input;
  // Flatten AgentMessage[] into a single text string for the SDK's Input type
  return input
    .map((m) => m.parts.map((p) => p.content ?? "").join(""))
    .join("\n");
}

function runToPromptResult(run: Run, runId: string): PromptResult {
  switch (run.status) {
    case "completed":
      return { status: "completed", output: runToOutput(run), runId };
    case "awaiting":
      return { status: "awaiting", awaitRequest: run.await_request, runId };
    case "failed":
      return {
        status: "failed",
        error: run.error?.message ?? "Run failed",
        runId,
      };
    case "cancelled":
    case "cancelling":
      return { status: "cancelled", runId };
    default:
      // Still running — shouldn't get here from terminal states
      return { status: "completed", output: runToOutput(run), runId };
  }
}

function runToOutput(run: Run): AgentMessage[] | undefined {
  if (!run.output?.length) return undefined;
  return run.output.map((msg) => ({
    role: (msg.role as "user" | "assistant") ?? "assistant",
    parts: msg.parts.map((p) => ({
      contentType: p.content_type ?? "text/plain",
      content: p.content ?? undefined,
      contentUrl: p.content_url ?? undefined,
    })),
  }));
}

function mapStreamEvent(event: Event): AgentEvent | null {
  switch (event.type) {
    case "message.part": {
      const part = event.part;
      return {
        type: "text",
        text: part.content ?? "",
        role: "assistant",
      };
    }
    case "message.created":
    case "message.completed":
      // Full message boundaries — no incremental content to emit
      return null;
    case "run.completed":
      return {
        type: "complete",
        reason: "end_turn",
        output: runToOutput(event.run),
      };
    case "run.failed":
      return {
        type: "error",
        code: "RUN_FAILED",
        message: event.run.error?.message ?? "Run failed",
      };
    case "run.awaiting":
      return { type: "pause", request: event.run.await_request };
    case "run.cancelled":
      return { type: "complete", reason: "cancelled" };
    case "error":
      return {
        type: "error",
        code: event.error.code,
        message: event.error.message,
      };
    default:
      return null;
  }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class IbmAcpAdapter implements IbmAcpAdapterInterface {
  // --- Core lifecycle ---

  async start(config: AgentStartConfig): Promise<SessionHandle> {
    const url = new URL(config.agent);
    const agentName = url.pathname.split("/").pop()!;
    const baseUrl = url.origin;

    const client = new Client({ baseUrl });
    const agentInfo = await client.agent(agentName);

    return {
      sessionId: config.sessionId ?? crypto.randomUUID(),
      protocol: "ibm",
      agent: {
        name: agentInfo.name ?? agentName,
        description: agentInfo.description ?? undefined,
      },
      connection: { url: baseUrl },
    };
  }

  async cancel(_session: SessionHandle): Promise<void> {
    // POST /runs/{runId}/cancel — requires runId context.
    // The VO stores pending_run with runId and handles cancellation
    // via the run state. This is a no-op placeholder at the adapter level.
  }

  async close(_session: SessionHandle): Promise<void> {
    // IBM ACP is stateless HTTP — no-op per SDD §2.3
  }

  // --- IBM-specific: split create + await for VO awakeable pattern ---

  async createRun(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): Promise<{ runId: string }> {
    const client = new Client({ baseUrl: session.connection.url! });
    const run = await client.runAsync(session.agent.name, toInput(input));
    return { runId: run.run_id };
  }

  // --- Sync (VO handler path, journaled) ---

  async promptSync(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): Promise<PromptResult> {
    const client = new Client({ baseUrl: session.connection.url! });
    const run = await client.runSync(session.agent.name, toInput(input));
    return runToPromptResult(run, run.run_id);
  }

  async resumeSync(
    session: SessionHandle,
    runId: string,
    payload: unknown,
  ): Promise<PromptResult> {
    const client = new Client({ baseUrl: session.connection.url! });
    // The SDK expects AwaitResume = { type: "message", message: Message }
    // Pass through if already shaped correctly, otherwise wrap
    const run = await client.runResumeSync(runId, payload as AwaitResume);
    return runToPromptResult(run, run.run_id);
  }

  // --- Streaming (API layer, not journaled) ---

  async *prompt(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): AsyncGenerator<AgentEvent> {
    const client = new Client({ baseUrl: session.connection.url! });
    for await (const event of client.runStream(
      session.agent.name,
      toInput(input),
    )) {
      const mapped = mapStreamEvent(event);
      if (mapped) yield mapped;
    }
  }

  async *resume(
    _session: SessionHandle,
    _payload: unknown,
  ): AsyncGenerator<AgentEvent> {
    // Streaming resume requires runId context from the caller.
    yield {
      type: "error",
      code: "NOT_IMPLEMENTED",
      message: "Streaming resume requires runId context",
    };
  }

  // --- Config ---

  async getConfigOptions(_session: SessionHandle): Promise<ConfigOption[]> {
    // IBM ACP agents may not support config options — return empty
    return [];
  }

  async setConfigOption(
    _session: SessionHandle,
    _configId: string,
    _value: string,
  ): Promise<ConfigOption[]> {
    return [];
  }
}
