/**
 * createRestateStream unit test — verifies the stream factory
 * returns a valid acp.Stream shape.
 */

import { describe, it, expect } from "vitest";
import { createRestateStream } from "../../src/client/index.js";
import { createPubsubClient } from "@restatedev/pubsub-client";

describe("createRestateStream", () => {
  it("returns an acp.Stream with readable and writable", () => {
    const pubsub = createPubsubClient({ name: "pubsub", ingressUrl: "http://localhost:18080" });
    const stream = createRestateStream({
      ingressUrl: "http://localhost:18080",
      sessionKey: "test-key",
      pubsub,
    });

    expect(stream.readable).toBeInstanceOf(ReadableStream);
    expect(stream.writable).toBeInstanceOf(WritableStream);
  });
});
