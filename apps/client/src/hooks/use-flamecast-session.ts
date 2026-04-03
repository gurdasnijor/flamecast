import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLog } from "@flamecast/protocol/session";
import { client } from "@/lib/api";

type ConnectionState = "disconnected" | "connecting" | "connected";

export function useFlamecastSession(sessionId: string) {
  const [events, setEvents] = useState<SessionLog[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setEvents([]);
    setConnectionState("connecting");

    const ac = new AbortController();
    abortRef.current = ac;

    (async () => {
      try {
        const stream = client.subscribeSSE(sessionId, { signal: ac.signal });
        setConnectionState("connected");

        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value as Uint8Array, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(line.slice(6));
                const log: SessionLog = {
                  type: parsed.type ?? "unknown",
                  data: parsed,
                  timestamp: new Date().toISOString(),
                };
                setEvents((prev) => [...prev, log]);
              } catch {
                // ignore malformed
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setConnectionState("disconnected");
        }
      }
    })();

    return () => {
      abortRef.current = null;
      ac.abort();
    };
  }, [sessionId]);

  const prompt = useCallback(
    (text: string) => {
      setEvents((prev) => [
        ...prev,
        {
          type: "prompt_sent",
          data: { text },
          timestamp: new Date().toISOString(),
        },
      ]);
      client.prompt(sessionId, text).catch(() => {});
    },
    [sessionId],
  );

  const cancel = useCallback(() => {
    client.close(sessionId).catch(() => {});
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
