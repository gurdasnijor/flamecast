import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLog } from "@flamecast/protocol/session";
import { flamecast, BrowserClient } from "@/lib/api";
import type * as acp from "@agentclientprotocol/sdk";

type ConnectionState = "disconnected" | "connecting" | "connected";

export interface PendingPermissionUI {
  requestId: string;
  toolCall: acp.RequestPermissionRequest["toolCall"];
  options: acp.RequestPermissionRequest["options"];
  resolve: (outcome: acp.RequestPermissionOutcome) => void;
}

export function useFlamecastSession(connectionId: string) {
  const [events, setEvents] = useState<SessionLog[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermissionUI[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const connRef = useRef<acp.ClientSideConnection | null>(null);

  useEffect(() => {
    setEvents([]);
    setPendingPermissions([]);
    setConnectionState("connecting");

    const browserClient = new BrowserClient();

    browserClient.onSessionUpdate = (params: acp.SessionNotification) => {
      const log: SessionLog = {
        type: "session_update",
        data: { update: params.update } as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      };
      setEvents((prev) => [...prev, log]);
    };

    browserClient.onPermissionRequest = (params: acp.RequestPermissionRequest) => {
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        const requestId = params.toolCall.toolCallId;
        const pending: PendingPermissionUI = {
          requestId,
          toolCall: params.toolCall,
          options: params.options,
          resolve: (outcome: acp.RequestPermissionOutcome) => {
            setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
            setEvents((prev) => [
              ...prev,
              { type: "permission_responded", data: { requestId, outcome } as Record<string, unknown>, timestamp: new Date().toISOString() },
            ]);
            resolve({ outcome });
          },
        };
        setPendingPermissions((prev) => [...prev, pending]);
        setEvents((prev) => [
          ...prev,
          { type: "permission_request", data: { requestId, toolCall: params.toolCall, options: params.options } as Record<string, unknown>, timestamp: new Date().toISOString() },
        ]);
      });
    };

    // Attach to existing durable connection — returns a standard ClientSideConnection
    const conn = flamecast.attach(connectionId, () => browserClient);
    connRef.current = conn;
    setConnectionState("connected");

    return () => {
      connRef.current = null;
    };
  }, [connectionId]);

  const prompt = useCallback(
    (text: string) => {
      setEvents((prev) => [
        ...prev,
        { type: "prompt_sent", data: { text }, timestamp: new Date().toISOString() },
      ]);
      connRef.current?.prompt({ sessionId: "", prompt: [{ type: "text", text }] }).catch(() => {});
    },
    [connectionId],
  );

  const cancel = useCallback(() => {
    connRef.current?.cancel({ sessionId: "" }).catch(() => {});
  }, [connectionId]);

  const respondPermission = useCallback(
    (requestId: string, outcome: acp.RequestPermissionOutcome) => {
      const pending = pendingPermissions.find((p) => p.requestId === requestId);
      if (pending) pending.resolve(outcome);
    },
    [pendingPermissions],
  );

  const addEvent = useCallback((log: SessionLog) => {
    setEvents((prev) => [...prev, log]);
  }, []);

  return {
    events,
    pendingPermissions,
    connectionState,
    isConnected: connectionState === "connected",
    prompt,
    cancel,
    respondPermission,
    addEvent,
  };
}
