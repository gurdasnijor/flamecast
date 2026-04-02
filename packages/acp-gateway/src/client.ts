/**
 * ACP Gateway Client — HTTP client for the gateway's ACP REST API.
 *
 * Designed to be used inside Restate service handlers:
 *
 *   const gateway = new GatewayClient("http://localhost:4000");
 *
 *   // Inside a Restate handler:
 *   const result = await ctx.run("agent-call", () =>
 *     gateway.runSync("claude-acp", [{ role: "user", parts: [...] }])
 *   );
 *
 * All methods return plain JSON — no streaming, no long-lived connections.
 * Restate wraps each call in ctx.run() for durability/journaling.
 */

import type {
  Message,
  MessagePart,
  AgentManifest,
  RunStatus,
  AwaitRequest,
} from "acp-sdk";

export type { Message, MessagePart, AgentManifest, RunStatus, AwaitRequest };

// ─── Gateway-specific response types ────────────────────────────────────────

export interface RunResult {
  id: string;
  agentName: string;
  status: RunStatus;
  output?: Message[];
  error?: string;
  awaitRequest?: AwaitRequest;
}

export interface RunStreamEvent {
  type: string;
  runId?: string;
  part?: MessagePart;
  output?: Message[];
  error?: string;
  awaitRequest?: unknown;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a text message (loose shape for input — gateway accepts raw JSON). */
export function textMessage(
  role: "user" | "agent",
  text: string,
): { role: string; parts: Array<{ content_type: string; content: string }> } {
  return {
    role,
    parts: [{ content_type: "text/plain", content: text }],
  };
}

/** Extract all text content from messages. */
export function extractText(messages: Message[]): string {
  return messages
    .flatMap((m) => m.parts)
    .map((p) => p.content ?? "")
    .filter(Boolean)
    .join("\n");
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class GatewayClient {
  constructor(private baseUrl: string) {}

  /** List all registered agents. */
  async agents(): Promise<AgentManifest[]> {
    const res = await fetch(`${this.baseUrl}/agents`);
    if (!res.ok) throw new Error(`GET /agents failed: ${res.status}`);
    return res.json() as Promise<AgentManifest[]>;
  }

  /** Get a single agent's info. */
  async agent(name: string): Promise<AgentManifest> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Agent "${name}" not found`);
    return res.json() as Promise<AgentManifest>;
  }

  /** Run synchronously — blocks until the agent completes. */
  async runSync(agentName: string, input: Message[]): Promise<RunResult> {
    return this.createRun(agentName, input, "sync");
  }

  /** Run asynchronously — returns immediately with run ID. */
  async runAsync(agentName: string, input: Message[]): Promise<RunResult> {
    return this.createRun(agentName, input, "async");
  }

  /**
   * Run with streaming — returns an async iterable of events.
   * Use with `for await`:
   *
   *   for await (const event of gateway.runStream("claude-acp", input)) {
   *     if (event.type === "message.part") console.log(event.part?.content);
   *   }
   */
  async *runStream(
    agentName: string,
    input: Message[],
  ): AsyncGenerator<RunStreamEvent> {
    const res = await fetch(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName, input, mode: "stream" }),
    });

    if (!res.ok) {
      throw new Error(`POST /runs (stream) failed: ${res.status}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          yield JSON.parse(line.slice(6)) as RunStreamEvent;
        }
      }
    }
  }

  /** Get the current status of a run. */
  async getRun(runId: string): Promise<RunResult> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}`);
    if (!res.ok) throw new Error(`Run "${runId}" not found`);
    return res.json() as Promise<RunResult>;
  }

  /** Cancel a run. */
  async cancelRun(runId: string): Promise<RunResult> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/cancel`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Cancel failed: ${res.status}`);
    return res.json() as Promise<RunResult>;
  }

  /** Resume an awaiting run with a permission decision. */
  async resumeRun(runId: string, optionId: string): Promise<RunResult> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId }),
    });
    if (!res.ok) throw new Error(`Resume failed: ${res.status}`);
    return res.json() as Promise<RunResult>;
  }

  /**
   * Poll a run until it reaches a terminal state.
   * Returns the final run result.
   */
  async waitForRun(
    runId: string,
    opts?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<RunResult> {
    const interval = opts?.pollIntervalMs ?? 1000;
    const timeout = opts?.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const run = await this.getRun(runId);
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled"
      ) {
        return run;
      }
      if (run.status === "awaiting") {
        return run; // caller handles resume
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Run ${runId} timed out after ${timeout}ms`);
  }

  // ─── Convenience ────────────────────────────────────────────────────────

  /** Quick run with a text prompt. Returns the output text. */
  async prompt(agentName: string, text: string): Promise<string> {
    const input = [textMessage("user", text)] as unknown as Message[];
    const result = await this.runSync(agentName, input);
    if (result.status === "failed") {
      throw new Error(`Agent failed: ${result.error}`);
    }
    return result.output ? extractText(result.output) : "";
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async createRun(
    agentName: string,
    input: Message[],
    mode: "sync" | "async" | "stream",
  ): Promise<RunResult> {
    const res = await fetch(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName, input, mode }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`POST /runs failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<RunResult>;
  }
}
