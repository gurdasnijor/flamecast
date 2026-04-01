/**
 * StdioAdapter — delegates agent lifecycle to RuntimeHost.
 *
 * Implements the adapter methods needed by the unified AgentSession VO:
 * - start: spawn agent via RuntimeHost
 * - promptAsync: tell RuntimeHost to drive agent, return immediately
 * - cancel: cancel current prompt
 * - close: kill agent process
 * - getConfigOptions / setConfigOption: no-op for now
 *
 * Reference: docs/re-arch-unification.md Change 4
 */

import type {
  RuntimeHost,
  ProcessHandle,

  RuntimeHostCallbacks,
} from "../runtime-host/types.js";

// ─── Types matching the VO's expectations ─────────────────────────────────

export interface AgentInfo {
  name: string;
  description?: string;
  capabilities?: Record<string, unknown>;
}

export interface SessionHandle {
  sessionId: string;
  protocol: "stdio" | "a2a";
  agent: AgentInfo;
  connection: {
    url?: string;
    pid?: number;
    containerId?: string;
    sandboxId?: string;
  };
}

export interface AgentStartConfig {
  agent: string;
  args?: string[];
  cwd?: string;
  sessionId?: string;
  env?: Record<string, string>;
}

export interface ConfigOption {
  id: string;
  label: string;
  type: "string" | "enum";
  value: string;
  options?: string[];
}

// ─── StdioAdapter ─────────────────────────────────────────────────────────

export class StdioAdapter {
  constructor(private runtimeHost: RuntimeHost) {}

  async start(config: AgentStartConfig): Promise<SessionHandle> {
    const sessionId = config.sessionId ?? crypto.randomUUID();
    const handle = await this.runtimeHost.spawn(sessionId, {
      strategy: "local",
      binary: config.agent,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
    });

    return {
      sessionId: handle.sessionId,
      protocol: "stdio",
      agent: {
        name: handle.agentName,
        description: handle.agentDescription,
        capabilities: handle.agentCapabilities,
      },
      connection: { pid: handle.pid },
    };
  }

  /**
   * Start a prompt — non-blocking. Drives the agent via RuntimeHost
   * callbacks. The VO suspends on an awakeable; RuntimeHost resolves
   * it when the agent reaches a terminal state.
   */
  async promptAsync(
    session: SessionHandle,
    text: string,
    callbacks: RuntimeHostCallbacks,
  ): Promise<void> {
    const handle: ProcessHandle = {
      sessionId: session.sessionId,
      strategy: "local",
      pid: session.connection.pid,
      agentName: session.agent.name,
    };
    // Fire and forget — RuntimeHost drives the agent
    this.runtimeHost
      .prompt(handle, text, callbacks)
      .catch((err) => callbacks.onError(err instanceof Error ? err : new Error(String(err))));
  }

  async cancel(session: SessionHandle): Promise<void> {
    await this.runtimeHost.cancel({
      sessionId: session.sessionId,
      strategy: "local",
      agentName: session.agent.name,
    });
  }

  async close(session: SessionHandle): Promise<void> {
    await this.runtimeHost.close({
      sessionId: session.sessionId,
      strategy: "local",
      agentName: session.agent.name,
    });
  }

  async getConfigOptions(_session: SessionHandle): Promise<ConfigOption[]> {
    return [];
  }

  async setConfigOption(
    _session: SessionHandle,
    _configId: string,
    _value: string,
  ): Promise<ConfigOption[]> {
    return [];
  }
}
