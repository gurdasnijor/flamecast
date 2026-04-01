import { describe, it, expect } from "vitest";
import { StdioAdapter } from "../../src/adapters/stdio.js";
import type {
  RuntimeHost,
  ProcessHandle,
  AgentSpec,
  RuntimeHostCallbacks,
} from "../../src/runtime-host/types.js";
import type { PromptResultPayload } from "@flamecast/protocol/session";

function createMockRuntimeHost(): RuntimeHost & {
  spawnCalls: Array<{ sessionId: string; spec: AgentSpec }>;
  promptCalls: Array<{ handle: ProcessHandle; text: string }>;
  cancelCalls: ProcessHandle[];
  closeCalls: ProcessHandle[];
} {
  const spawnCalls: Array<{ sessionId: string; spec: AgentSpec }> = [];
  const promptCalls: Array<{ handle: ProcessHandle; text: string }> = [];
  const cancelCalls: ProcessHandle[] = [];
  const closeCalls: ProcessHandle[] = [];

  return {
    spawnCalls,
    promptCalls,
    cancelCalls,
    closeCalls,

    spawn: async (sessionId, spec) => {
      spawnCalls.push({ sessionId, spec });
      return {
        sessionId,
        strategy: spec.strategy,
        pid: 1234,
        agentName: spec.binary ?? "mock-agent",
      };
    },

    prompt: async (handle, text, cbs) => {
      promptCalls.push({ handle, text });
      cbs.onEvent({ type: "text", text: "Hello!", role: "assistant" });
      cbs.onComplete({
        status: "completed",
        output: [
          {
            role: "assistant",
            parts: [{ contentType: "text/plain", content: "Hello!" }],
          },
        ],
        runId: handle.sessionId,
      });
    },

    cancel: async (handle) => {
      cancelCalls.push(handle);
    },

    close: async (handle) => {
      closeCalls.push(handle);
    },
  };
}

describe("StdioAdapter", () => {
  it("start delegates to runtimeHost.spawn", async () => {
    const host = createMockRuntimeHost();
    const adapter = new StdioAdapter(host);

    const session = await adapter.start({
      agent: "codex",
      args: ["--acp"],
      cwd: "/tmp/workspace",
      sessionId: "sess-1",
    });

    expect(host.spawnCalls).toHaveLength(1);
    expect(host.spawnCalls[0].spec).toEqual({
      strategy: "local",
      binary: "codex",
      args: ["--acp"],
      cwd: "/tmp/workspace",
      env: undefined,
    });

    expect(session.sessionId).toBe("sess-1");
    expect(session.protocol).toBe("stdio");
    expect(session.agent.name).toBe("codex");
    expect(session.connection.pid).toBe(1234);
  });

  it("promptAsync delegates to runtimeHost.prompt", async () => {
    const host = createMockRuntimeHost();
    const adapter = new StdioAdapter(host);

    const session = await adapter.start({
      agent: "codex",
      sessionId: "sess-1",
    });

    const events: unknown[] = [];
    let result: PromptResultPayload | null = null;

    await adapter.promptAsync(session, "say hello", {
      onEvent: (e) => events.push(e),
      onPermission: async (req) => ({ optionId: req.options[0].optionId }),
      onComplete: (r) => {
        result = r;
      },
      onError: () => {},
    });

    // Give the fire-and-forget prompt a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(host.promptCalls).toHaveLength(1);
    expect(host.promptCalls[0].text).toBe("say hello");
    expect(events).toHaveLength(1);
    expect(result?.status).toBe("completed");
  });

  it("cancel delegates to runtimeHost.cancel", async () => {
    const host = createMockRuntimeHost();
    const adapter = new StdioAdapter(host);

    const session = await adapter.start({
      agent: "codex",
      sessionId: "sess-1",
    });
    await adapter.cancel(session);

    expect(host.cancelCalls).toHaveLength(1);
    expect(host.cancelCalls[0].sessionId).toBe("sess-1");
  });

  it("close delegates to runtimeHost.close", async () => {
    const host = createMockRuntimeHost();
    const adapter = new StdioAdapter(host);

    const session = await adapter.start({
      agent: "codex",
      sessionId: "sess-1",
    });
    await adapter.close(session);

    expect(host.closeCalls).toHaveLength(1);
    expect(host.closeCalls[0].sessionId).toBe("sess-1");
  });
});
