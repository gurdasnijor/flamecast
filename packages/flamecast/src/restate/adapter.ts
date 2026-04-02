/**
 * Types for ACP agent orchestration.
 *
 * Defines the unified interface that abstracts stdio
 * and a2a (HTTP) protocols.
 *
 */

// ─── Agent Events (streaming + control-plane) ─────────────────────────────

export type AgentEvent =
  | { type: "text"; text: string; role: "assistant" | "thinking" }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      status: "pending" | "running" | "completed" | "failed";
      input?: unknown;
      output?: unknown;
    }
  | { type: "pause"; request: unknown }
  | {
      type: "complete";
      reason: "end_turn" | "cancelled" | "failed" | "max_tokens";
      output?: AgentMessage[];
    }
  | { type: "error"; code: string; message: string };

// ─── Messages ──────────────────────────────────────────────────────────────

export interface AgentMessage {
  role: "user" | "assistant";
  parts: Array<{
    contentType: string;
    content?: string;
    contentUrl?: string;
  }>;
}

// ─── Agent Info ────────────────────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  description?: string;
  capabilities?: Record<string, unknown>;
}

// ─── Session Handle (stored in VO state) ───────────────────────────────────

export interface SessionHandle {
  sessionId: string;
  protocol: "stdio" | "a2a";
  agent: AgentInfo;
  connection: {
    url?: string;
    pid?: number;
    containerId?: string;
    sandboxId?: string;
  };
}

// ─── Start Config ──────────────────────────────────────────────────────────

export interface AgentCallbacks {
  onPermissionRequest?: (request: unknown) => Promise<unknown>;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentStartConfig {
  agent: string; // Binary path (stdio) or endpoint URL (a2a)
  args?: string[]; // Command-line arguments (e.g., ["--acp"])
  cwd?: string; // Working directory
  sessionId?: string; // Explicit session ID
  env?: Record<string, string>;
  callbacks?: AgentCallbacks;
  strategy?: "local" | "docker" | "e2b";
  containerImage?: string;
}

// ─── Prompt Result (journaled by ctx.run()) ────────────────────────────────

export interface PromptResult {
  status: "completed" | "awaiting" | "failed" | "cancelled";
  output?: AgentMessage[];
  awaitRequest?: unknown; // present when status === "awaiting"
  runId?: string; 
  error?: string; // present when status === "failed"
}

// ─── Config Options (ACP session configuration) ────────────────────────────

export interface ConfigOption {
  id: string;
  label: string;
  type: "string" | "enum";
  value: string;
  options?: string[];
}

// ─── Session Metadata (stored in VO state as "meta") ───────────────────────

export interface SessionMeta {
  sessionId: string;
  protocol: "stdio" | "a2a";
  agent: AgentInfo;
  status: "active" | "running" | "paused" | "completed" | "failed" | "killed";
  startedAt: string;
  lastUpdatedAt: string;
}

