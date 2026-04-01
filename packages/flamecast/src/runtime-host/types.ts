/**
 * RuntimeHost — interface for managing agent process lifecycles.
 *
 * The RuntimeHost holds live process handles (stdio pipes, child processes)
 * that cannot survive VO suspension. It runs in-process for local dev
 * (InProcessRuntimeHost) or as an HTTP sidecar for deployed environments
 * (RemoteRuntimeHost, Step 8).
 *
 * Reference: docs/re-arch-unification.md Change 3
 */

import type { PromptResultPayload } from "@flamecast/protocol/session";

// ─── Streaming Event (from agent to host during prompt) ───────────────────

export type StreamingEvent =
  | { type: "text"; text: string; role: "assistant" | "thinking" }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      status: "pending" | "running" | "completed" | "failed";
      input?: unknown;
      output?: unknown;
    };

// ─── Agent Spec ───────────────────────────────────────────────────────────

export interface AgentSpec {
  strategy: "local" | "docker" | "e2b";
  binary?: string;
  args?: string[];
  containerImage?: string;
  sandboxTemplate?: string;
  cwd?: string;
  env?: Record<string, string>;
}

// ─── Process Handle ───────────────────────────────────────────────────────

export interface ProcessHandle {
  sessionId: string;
  strategy: AgentSpec["strategy"];
  pid?: number;
  containerId?: string;
  sandboxId?: string;
  agentName: string;
  agentDescription?: string;
  agentCapabilities?: Record<string, unknown>;
}

// ─── Callbacks ────────────────────────────────────────────────────────────

export interface RuntimeHostCallbacks {
  /** Called for each streaming event (text chunk, tool call status). */
  onEvent(event: StreamingEvent): void;
  /** Called when the agent requests permission. Must return the decision. */
  onPermission(request: PermissionRequest): Promise<PermissionDecision>;
  /** Called when the prompt reaches a terminal state. */
  onComplete(result: PromptResultPayload): void;
  /** Called on unrecoverable error. */
  onError(err: Error): void;
}

export interface PermissionRequest {
  toolCallId: string;
  title: string;
  kind?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface PermissionDecision {
  optionId: string;
}

// ─── RuntimeHost Interface ────────────────────────────────────────────────

export interface RuntimeHost {
  /**
   * Spawn an agent process and initialize the ACP connection.
   * Returns a ProcessHandle with agent info.
   */
  spawn(sessionId: string, spec: AgentSpec): Promise<ProcessHandle>;

  /**
   * Start a prompt on an already-spawned agent.
   * Non-blocking — drives the agent via callbacks.
   * The onComplete callback fires when the agent reaches a terminal state.
   */
  prompt(
    handle: ProcessHandle,
    text: string,
    callbacks: RuntimeHostCallbacks,
  ): Promise<void>;

  /** Cancel the current prompt on the agent. */
  cancel(handle: ProcessHandle): Promise<void>;

  /** Kill the agent process and clean up. */
  close(handle: ProcessHandle): Promise<void>;
}
