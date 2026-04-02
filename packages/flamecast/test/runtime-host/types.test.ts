import { describe, it, expect } from "vitest";
import type {
  RuntimeHost,
  AgentSpec,
  ProcessHandle,
  RuntimeHostCallbacks,
  PermissionRequest,
  StreamingEvent,
} from "../../src/runtime-host/types.js";
import type { PromptResultPayload } from "@flamecast/protocol/session";

describe("RuntimeHost types", () => {
  it("AgentSpec has required fields", () => {
    const spec: AgentSpec = {
      strategy: "local",
      binary: "codex",
      args: ["--acp"],
      cwd: "/tmp",
      env: { MODEL: "gpt-4" },
    };
    expect(spec.strategy).toBe("local");
    expect(spec.binary).toBe("codex");
  });

  it("ProcessHandle carries agent info", () => {
    const handle: ProcessHandle = {
      sessionId: "sess-1",
      strategy: "local",
      pid: 12345,
      agentName: "codex",
      agentDescription: "OpenAI Codex",
    };
    expect(handle.agentName).toBe("codex");
    expect(handle.pid).toBe(12345);
  });

  it("RuntimeHostCallbacks shape is correct", () => {
    const events: StreamingEvent[] = [];
    const results: PromptResultPayload[] = [];
    const permissions: PermissionRequest[] = [];

    const cbs: RuntimeHostCallbacks = {
      onEvent: (e) => events.push(e),
      onPermission: async (req) => {
        permissions.push(req);
        return { optionId: req.options[0].optionId };
      },
      onComplete: (r) => results.push(r),
      onError: (err) => {
        throw err;
      },
    };

    cbs.onEvent({ type: "text", text: "hello", role: "assistant" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "text",
      text: "hello",
      role: "assistant",
    });

    cbs.onComplete({ status: "completed", runId: "r1" });
    expect(results).toHaveLength(1);
  });

  it("RuntimeHost interface can be implemented as a mock", async () => {
    const mock: RuntimeHost = {
      spawn: async (sessionId, spec) => ({
        sessionId,
        strategy: spec.strategy,
        pid: 999,
        agentName: "mock-agent",
      }),
      prompt: async (_handle, _text, cbs) => {
        cbs.onEvent({ type: "text", text: "hi", role: "assistant" });
        cbs.onComplete({ status: "completed", runId: "r1" });
      },
      cancel: async () => {},
      close: async () => {},
    };

    const handle = await mock.spawn("s1", {
      strategy: "local",
      binary: "echo",
    });
    expect(handle.agentName).toBe("mock-agent");

    const events: StreamingEvent[] = [];
    let result: PromptResultPayload | null = null;
    await mock.prompt(handle, "test", {
      onEvent: (e) => events.push(e),
      onPermission: async (req) => ({ optionId: req.options[0].optionId }),
      onComplete: (r) => {
        result = r;
      },
      onError: () => {},
    });

    expect(events).toHaveLength(1);
    expect(result!.status).toBe("completed");
  });
});
