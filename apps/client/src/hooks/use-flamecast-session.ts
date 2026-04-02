import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLog } from "@flamecast/protocol/session";

type ConnectionState = "disconnected" | "connecting" | "connected";

export function useFlamecastSession(sessionId: string) {
  const [events, setEvents] = useState<SessionLog[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setEvents([]);
    setConnectionState("connecting");

    const es = new EventSource(`/acp/runs/${sessionId}/events`);
    esRef.current = es;

    es.onopen = () => setConnectionState("connected");

    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        const log: SessionLog = {
          type: parsed.type ?? "unknown",
          data: parsed,
          timestamp: new Date().toISOString(),
        };
        setEvents((prev) => [...prev, log]);
      } catch {
        // ignore malformed SSE data
      }
    };

    es.onerror = () => {
      setConnectionState("disconnected");
    };

    return () => {
      esRef.current = null;
      es.close();
    };
  }, [sessionId]);

  const prompt = useCallback(
    (text: string) => {
      setEvents((prev) => [
        ...prev,
        { type: "prompt_sent", data: { text }, timestamp: new Date().toISOString() },
      ]);
      // Create a new run with the prompt
      fetch(`/acp/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentName: "claude-acp", prompt: text, mode: "async" }),
      }).catch(() => {});
    },
    [sessionId],
  );

  const cancel = useCallback(() => {
    fetch(`/acp/runs/${sessionId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }, [sessionId]);

  const requestFilePreview = useCallback(
    (_filePath: string) => Promise.resolve({ content: "" }),
    [],
  );

  const requestFsSnapshot = useCallback(
    (_opts?: { showAllFiles?: boolean }) =>
      Promise.resolve({ root: "", entries: [] }),
    [],
  );

  const addEvent = useCallback((log: SessionLog) => {
    setEvents((prev) => [...prev, log]);
  }, []);

  return {
    events,
    connectionState,
    isConnected: connectionState === "connected",
    prompt,
    cancel,
    addEvent,
    requestFilePreview,
    requestFsSnapshot,
  };
}
