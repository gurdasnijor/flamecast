import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLog } from "@flamecast/sdk/session";

type ConnectionState = "disconnected" | "connecting" | "connected";

export function useFlamecastSession(sessionId: string) {
  const [events, setEvents] = useState<SessionLog[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setEvents([]);
    setConnectionState("connecting");

    const es = new EventSource(`/api/sessions/${sessionId}/events`);
    esRef.current = es;

    es.onopen = () => setConnectionState("connected");

    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        // Pubsub events with a nested `data` object (e.g. permission_request)
        // need unwrapping so the page can parse them directly.
        const data =
          parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
            ? parsed.data
            : parsed;
        const log: SessionLog = {
          type: parsed.type ?? "unknown",
          data,
          timestamp: parsed.timestamp ?? new Date().toISOString(),
        };
        setEvents((prev) => [...prev, log]);
      } catch {
        // ignore malformed SSE data
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; mark disconnected while retrying
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
      fetch(`/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    },
    [sessionId],
  );

  const cancel = useCallback(() => {
    fetch(`/api/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }, [sessionId]);

  const requestFilePreview = useCallback(
    (filePath: string) =>
      fetch(
        `/api/sessions/${sessionId}/files?path=${encodeURIComponent(filePath)}`,
      ).then((r) => r.json()),
    [sessionId],
  );

  const requestFsSnapshot = useCallback(
    (_opts?: { showAllFiles?: boolean }) =>
      fetch(`/api/sessions/${sessionId}/fs`).then((r) => r.json()),
    [sessionId],
  );

  return {
    events,
    connectionState,
    isConnected: connectionState === "connected",
    prompt,
    cancel,
    requestFilePreview,
    requestFsSnapshot,
  };
}
