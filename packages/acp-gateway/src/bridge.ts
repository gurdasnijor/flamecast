/**
 * Bridge — bidirectional translation between BeeAI ACP REST types and
 * JetBrains ACP stdio types.
 *
 * HTTP surface types from `acp-sdk` (BeeAI ACP TypeScript SDK).
 * MessagePart shape: { content, content_type, content_url, content_encoding, metadata }
 */

export type {
  Message,
  MessagePart,
  Run,
  RunStatus,
  RunMode,
  RunId,
  AgentManifest,
  Event,
  RunCreatedEvent,
  RunInProgressEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunCancelledEvent,
  RunAwaitingEvent,
  MessageCreatedEvent,
  MessagePartEvent,
  MessageCompletedEvent,
  AwaitRequest,
  AwaitResume,
  SessionId,
} from "acp-sdk";

export type {
  RunCreateRequest,
  RunCreateResponse,
  RunReadResponse,
  RunResumeRequest,
  RunResumeResponse,
  AgentsListResponse,
  AgentsReadResponse,
} from "acp-sdk";

import type { Message } from "acp-sdk";

// Raw input shape from HTTP — not Zod-validated, so be lenient
interface RawMessage {
  role?: string;
  parts: Array<{
    content?: string | null;
    content_type?: string | null;
    // Also accept the legacy { type, text } shape for convenience
    type?: string;
    text?: string;
  }>;
}

// ─── HTTP → stdio ───────────────────────────────────────────────────────────

/** Extract text content from incoming messages for stdio agent prompt. */
export function messagesToText(messages: RawMessage[]): string {
  return messages
    .flatMap((m) => m.parts)
    .map((p) => {
      // BeeAI spec: content_type + content
      if (p.content) return p.content;
      // Legacy/convenience: type + text
      if (p.text) return p.text;
      return null;
    })
    .filter(Boolean)
    .join("\n");
}

// ─── stdio → ACP ────────────────────────────────────────────────────────────

/** Wrap plain text from stdio agent into BeeAI ACP Message format. */
export function textToMessages(
  text: string,
  role: "user" | "agent",
): Message[] {
  if (!text) return [];
  return [
    {
      role,
      parts: [
        {
          content_type: "text/plain",
          content: text,
          content_encoding: "plain" as const,
        },
      ],
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    },
  ];
}
