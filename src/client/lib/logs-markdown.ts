import type { ConnectionLog } from "@/shared/connection";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type ConnectionLogMarkdownSegment =
  | { kind: "assistant"; text: string }
  | { kind: "user"; text: string }
  | { kind: "tool"; toolCallId: string; title: string; status: string };

function appendAssistant(segments: ConnectionLogMarkdownSegment[], chunk: string): void {
  const last = segments.at(-1);
  if (last?.kind === "assistant") {
    last.text += chunk;
  } else {
    segments.push({ kind: "assistant", text: chunk });
  }
}

function appendUser(segments: ConnectionLogMarkdownSegment[], chunk: string): void {
  const last = segments.at(-1);
  if (last?.kind === "user") {
    last.text += chunk;
  } else {
    segments.push({ kind: "user", text: chunk });
  }
}

/** Ordered segments for the markdown tab (prompts + session stream updates). */
export function connectionLogsToSegments(logs: ConnectionLog[]): ConnectionLogMarkdownSegment[] {
  const segments: ConnectionLogMarkdownSegment[] = [];

  for (const log of logs) {
    if (log.type === "prompt_sent") {
      const d = log.data;
      if (isRecord(d) && typeof d.text === "string" && d.text.length > 0) {
        appendUser(segments, d.text);
      }
      continue;
    }

    if (log.type !== "session_update") continue;
    const d = log.data;
    if (!isRecord(d)) continue;
    const su = d.sessionUpdate;
    if (typeof su !== "string") continue;

    if (su === "agent_message_chunk") {
      const content = d.content;
      if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
        appendAssistant(segments, content.text);
      }
    } else if (su === "user_message_chunk") {
      const content = d.content;
      if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
        appendUser(segments, content.text);
      }
    } else if (su === "tool_call") {
      const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : "";
      const title = typeof d.title === "string" ? d.title : "Tool";
      const status = typeof d.status === "string" ? d.status : "";
      segments.push({ kind: "tool", toolCallId, title, status });
    } else if (su === "tool_call_update") {
      const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : "";
      if (!toolCallId) continue;
      const status = typeof d.status === "string" ? d.status : "";
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg.kind === "tool" && seg.toolCallId === toolCallId) {
          if (status) seg.status = status;
          break;
        }
      }
    }
  }

  return segments;
}
