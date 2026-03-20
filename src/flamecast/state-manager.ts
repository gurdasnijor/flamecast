import type { ConnectionInfo, ConnectionLog } from "../shared/connection.js";

/** Durable slice of {@link ConnectionInfo} (everything except `logs`). */
export type ConnectionMeta = Omit<ConnectionInfo, "logs">;

/**
 * Durable backing store for orchestrator state. Runtime (child process, ACP stream)
 * stays in memory; the state manager is the source of truth for metadata and logs.
 */
export type FlamecastStateManager = {
  allocateConnectionId(): Promise<string>;
  createConnection(meta: ConnectionMeta): Promise<void>;
  updateConnection(
    id: string,
    patch: Partial<Pick<ConnectionMeta, "sessionId" | "lastUpdatedAt" | "pendingPermission">>,
  ): Promise<void>;
  appendLog(connectionId: string, sessionId: string, log: ConnectionLog): Promise<void>;
  getConnectionMeta(id: string): Promise<ConnectionMeta | null>;
  getLogs(connectionId: string): Promise<ConnectionLog[]>;
  listConnections(): Promise<ConnectionMeta[]>;
  /** Called after the last kill log is appended — mark connection {@link ConnectionMeta.status} as killed (do not remove). */
  finalizeConnection(id: string, reason: "killed"): Promise<void>;
};
