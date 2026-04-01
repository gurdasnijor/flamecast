import { describe, it, expect } from "vitest";
import { mapA2AEvent, type A2ATaskEvent } from "../src/a2a.js";

describe("mapA2AEvent", () => {
  it("maps artifact text to text event", () => {
    const event: A2ATaskEvent = {
      type: "task.artifact.update",
      task: {
        id: "t1",
        artifacts: [{ parts: [{ text: "Hello world", type: "text" }] }],
      },
    };
    const result = mapA2AEvent(event);
    expect(result).toEqual({
      type: "text",
      text: "Hello world",
      role: "assistant",
    });
  });

  it("maps completed status to complete event", () => {
    const event: A2ATaskEvent = {
      type: "task.status.update",
      task: {
        id: "t1",
        status: { state: "completed" },
      },
    };
    const result = mapA2AEvent(event);
    expect(result?.type).toBe("complete");
  });

  it("maps failed status to error event", () => {
    const event: A2ATaskEvent = {
      type: "task.status.update",
      task: {
        id: "t1",
        status: { state: "failed", message: "Out of memory" },
      },
    };
    const result = mapA2AEvent(event);
    expect(result).toEqual({
      type: "error",
      code: "AGENT_FAILED",
      message: "Out of memory",
    });
  });

  it("maps input-required to pause event", () => {
    const event: A2ATaskEvent = {
      type: "task.status.update",
      task: {
        id: "t1",
        status: { state: "input-required", message: "Need approval" },
      },
    };
    const result = mapA2AEvent(event);
    expect(result).toEqual({
      type: "pause",
      request: "Need approval",
    });
  });

  it("returns null for unknown events", () => {
    expect(mapA2AEvent({ type: "unknown" })).toBeNull();
    expect(mapA2AEvent({ type: "task.update", task: { id: "t1" } })).toBeNull();
  });
});
