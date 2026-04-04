import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLog } from "@flamecast/protocol/session";
import { connectSession, BrowserClient, pubsub } from "@/lib/api";
import type * as acp from "@agentclientprotocol/sdk";

type ConnectionState = "disconnected" | "connecting" | "connected";

export function useFlamecastSession(sessionId: string) {
  const [events, setEvents] = useState<SessionLog[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const connRef = useRef<acp.ClientSideConnection | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setEvents([]);
    setConnectionState("connecting");

    const ac = new AbortController();
    abortRef.current = ac;

    // Create a BrowserClient that feeds events into React state
    const client = new BrowserClient();
    client.onSessionUpdate = (params) => {
      const log: SessionLog = {
        type: params.update.sessionUpdate ?? "session_update",
        data: params.update as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      };
      setEvents((prev) => [...prev, log]);
    };

    const conn = connectSession(sessionId, client);
    connRef.current = conn;
    setConnectionState("connected");

    // Also listen to raw pubsub for events the ClientSideConnection doesn't route
    (async () => {
      try {
        for await (const event of pubsub.pull({ topic: `session:${sessionId}`, signal: ac.signal })) {
          if (event?.type && event.type !== "session_update" && event.type !== "permission_request") {
            const log: SessionLog = {
              type: event.type,
              data: event,
              timestamp: new Date().toISOString(),
            };
            setEvents((prev) => [...prev, log]);
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
      connRef.current = null;
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
      connRef.current?.prompt({ sessionId, prompt: [{ type: "text", text }] }).catch(() => {});
    },
    [sessionId],
  );

  const cancel = useCallback(() => {
    connRef.current?.cancel({ sessionId }).catch(() => {});
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
