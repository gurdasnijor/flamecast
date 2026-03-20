import type { AgentSpawn } from "../shared/connection.js";

export type RuntimeKind = "local" | "docker";

export interface AcpTransportStreams {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
}

export interface SandboxRuntime {
  streams: AcpTransportStreams;
  dispose: () => void | Promise<void>;
}

export interface SandboxStartOptions {
  spawn: AgentSpawn;
  agentProcessId?: string;
  /** Used for unique Docker image tags per connection. */
  connectionId?: string;
  /** Present when `runtimeKind` is `docker`: build image then run agent command inside it. */
  docker?: {
    dockerfile: string;
    contextDir: string;
  };
}

export interface SandboxProvisioner {
  start: (opts: SandboxStartOptions) => Promise<SandboxRuntime>;
}
