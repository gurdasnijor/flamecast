/**
 * Smoke test — verifies the VO and exports are importable.
 */

import { describe, it, expect } from "vitest";
import { AcpConnection, pubsubObject, createDurableStream } from "../../src/index.js";

describe("exports", () => {
  it("AcpConnection has name property", () => {
    expect(AcpConnection.name).toBe("AcpConnection");
  });

  it("pubsubObject has name property", () => {
    expect(pubsubObject.name).toBe("pubsub");
  });

  it("createDurableStream is a function", () => {
    expect(typeof createDurableStream).toBe("function");
  });
});
