import type { FileSystemEntry } from "./session-host.js";

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentSpawn {
  command: string;
  args: string[];
}

export interface AgentTemplateRuntime {
  provider: string;
  image?: string;
  dockerfile?: string;
  setup?: string;
  env?: Record<string, string>;
}

export interface AgentTemplate {
  id: string;
  name: string;
  spawn: AgentSpawn;
  runtime: AgentTemplateRuntime;
  env?: Record<string, string>;
  description?: string;
  icon?: string;
}

// ---------------------------------------------------------------------------
// Session state (API responses + SSE events)
// ---------------------------------------------------------------------------

export interface SessionLog {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface PendingPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PendingPermission {
  requestId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: PendingPermissionOption[];
}

export interface FileSystemSnapshot {
  root: string;
  entries: FileSystemEntry[];
  truncated: boolean;
  maxEntries: number;
}

export interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
  maxChars: number;
}

/** Agent info as stored in VO state. */
export interface SessionAgentInfo {
  name: string;
  description?: string;
  capabilities?: Record<string, unknown>;
}

/** Metadata stored in VO state — returned by getStatus. */
export interface SessionMeta {
  sessionId: string;
  protocol: "stdio" | "a2a";
  agent: SessionAgentInfo;
  status: "active" | "running" | "paused" | "completed" | "failed" | "killed";
  startedAt: string;
  lastUpdatedAt: string;
  cwd?: string;
}

/** Result of a prompt run — journaled by the VO. */
export interface PromptResultPayload {
  status: "completed" | "awaiting" | "failed" | "cancelled";
  output?: Array<{
    role: "user" | "assistant";
    parts: Array<{ contentType: string; content?: string; contentUrl?: string }>;
  }>;
  runId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Session events (published by VOs to pubsub, consumed by frontend via SSE)
// All events are FLAT — type at top level, all fields at top level.
// ---------------------------------------------------------------------------

export type SessionEvent =
  | { type: "session.created"; meta: SessionMeta }
  | { type: "session.terminated" }
  | { type: "run.started"; runId: string }
  | { type: "complete"; result: PromptResultPayload }
  | { type: "pause"; request: unknown; generation: number }
  | {
      type: "permission_request";
      requestId: string;
      toolCallId: string;
      title: string;
      kind?: string;
      options: PendingPermissionOption[];
      awakeableId: string;
      generation: number;
    }
  // Permission resolution — emitted by resumeAgent so RuntimeHost can unblock
  | { type: "permission_responded"; awakeableId: string; decision: unknown }
  // Streaming events — published in real-time as the agent works
  | { type: "text"; text: string; role: "assistant" | "thinking" }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      status: "pending" | "running" | "completed" | "failed";
      input?: unknown;
      output?: unknown;
    };


// ---------------------------------------------------------------------------
// API request bodies
// ---------------------------------------------------------------------------

export interface CreateSessionBody {
  cwd?: string;
  agentTemplateId?: string;
  spawn?: AgentSpawn;
  name?: string;
  webhooks?: Omit<WebhookConfig, "id">[];
}

export interface RegisterAgentTemplateBody {
  name: string;
  spawn: AgentSpawn;
  runtime?: AgentTemplateRuntime;
  env?: Record<string, string>;
}

export interface PromptBody {
  text: string;
}

export type PermissionResponseBody = { optionId: string } | { outcome: "cancelled" };

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

export type WebhookEventType = "permission_request" | "end_turn" | "error" | "session_end";

export interface WebhookConfig {
  id: string;
  url: string;
  secret: string;
  events?: WebhookEventType[];
}

export interface WebhookPayload {
  sessionId: string;
  eventId: string;
  timestamp: string;
  event: {
    type: WebhookEventType;
    data: Record<string, unknown>;
  };
}
