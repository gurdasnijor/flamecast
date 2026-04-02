import { describe, it, expect } from "vitest";
import { createTestRuntime } from "../../src/runtime/test.js";

describe("createTestRuntime", () => {
  it("step() calls fn and returns its value", async () => {
    const rt = createTestRuntime();
    const result = await rt.step("add", async () => 42);
    expect(result).toBe(42);
  });

  it("step() propagates errors", async () => {
    const rt = createTestRuntime();
    await expect(
      rt.step("fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("sleep() resolves immediately", async () => {
    const rt = createTestRuntime();
    await rt.sleep(60_000); // should not actually wait
  });

  it("now() returns an ISO timestamp", async () => {
    const rt = createTestRuntime();
    const ts = await rt.now();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("key returns the session ID", () => {
    const rt = createTestRuntime("my-session");
    expect(rt.key).toBe("my-session");
  });

  describe("state", () => {
    it("get returns null for missing keys", async () => {
      const rt = createTestRuntime();
      expect(await rt.state.get("missing")).toBeNull();
    });

    it("set + get round-trips", async () => {
      const rt = createTestRuntime();
      rt.state.set("foo", { bar: 1 });
      expect(await rt.state.get("foo")).toEqual({ bar: 1 });
    });

    it("clear removes a key", async () => {
      const rt = createTestRuntime();
      rt.state.set("foo", "val");
      rt.state.clear("foo");
      expect(await rt.state.get("foo")).toBeNull();
    });

    it("clearAll removes all keys", async () => {
      const rt = createTestRuntime();
      rt.state.set("a", 1);
      rt.state.set("b", 2);
      rt.state.clearAll();
      expect(await rt.state.get("a")).toBeNull();
      expect(await rt.state.get("b")).toBeNull();
      expect(rt.stateMap.size).toBe(0);
    });
  });

  describe("emit", () => {
    it("appends events to the events array", () => {
      const rt = createTestRuntime();
      rt.emit({ type: "session.terminated" });
      rt.emit({ type: "run.started", runId: "r1" });
      expect(rt.events).toHaveLength(2);
      expect(rt.events[0].type).toBe("session.terminated");
      expect(rt.events[1]).toEqual({ type: "run.started", runId: "r1" });
    });
  });

  describe("createDurablePromise + resolveDurablePromise", () => {
    it("round-trips: create → resolve → await", async () => {
      const rt = createTestRuntime();

      // Follow the prescribed call pattern
      const gen = ((await rt.state.get<number>("generation")) ?? 0) + 1;
      rt.state.set("generation", gen);
      const dp = rt.createDurablePromise<{ answer: number }>("test", gen);

      expect(dp.id).toContain("dp-test");
      expect(dp.id).toContain(`gen${gen}`);

      // Resolve with generation check
      rt.resolveDurablePromise(dp.id, gen, { answer: 42 });

      const result = await dp.promise;
      expect(result).toEqual({ answer: 42 });
    });

    it("stores pending_pause in state", async () => {
      const rt = createTestRuntime();
      rt.state.set("generation", 1);
      const dp = rt.createDurablePromise("pause", 1);

      const pending = await rt.state.get<{
        id: string;
        generation: number;
        tag: string;
      }>("pending_pause");
      expect(pending).toEqual({ id: dp.id, generation: 1, tag: "pause" });
    });

    it("resolveDurablePromise throws on generation mismatch", async () => {
      const rt = createTestRuntime();
      rt.state.set("generation", 1);
      const dp = rt.createDurablePromise("test", 1);

      expect(() => {
        rt.resolveDurablePromise(dp.id, 999, {});
      }).toThrow("Stale resume — generation mismatch");
    });

    it("resolveDurablePromise throws when no pending_pause", () => {
      const rt = createTestRuntime();
      // No createDurablePromise called
      expect(() => {
        rt.resolveDurablePromise("fake-id", 1, {});
      }).toThrow("Stale resume — generation mismatch");
    });

    it("resolveDurablePromiseById bypasses generation check", async () => {
      const rt = createTestRuntime();
      rt.state.set("generation", 1);
      const dp = rt.createDurablePromise<string>("direct", 1);

      rt.resolveDurablePromiseById(dp.id, "hello");
      expect(await dp.promise).toBe("hello");
    });

    it("multiple durable promises get unique IDs", () => {
      const rt = createTestRuntime();
      const dp1 = rt.createDurablePromise("a", 1);
      const dp2 = rt.createDurablePromise("b", 2);
      expect(dp1.id).not.toBe(dp2.id);
    });
  });

  describe("scheduleCleanup", () => {
    it("increments cleanup count (no-op in test)", () => {
      const rt = createTestRuntime();
      expect(rt.cleanupCount).toBe(0);
      rt.scheduleCleanup(7 * 24 * 60 * 60 * 1000);
      expect(rt.cleanupCount).toBe(1);
    });
  });
});
