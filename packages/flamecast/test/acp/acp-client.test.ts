/**
 * FlamecastClient unit test — verifies the ACP Agent interface
 * compiles and the basic API shape is correct.
 *
 * Full E2E tests are in test/integration/acp-compliance.test.ts
 */

import { describe, it, expect } from "vitest";
import { FlamecastClient } from "../../src/client/index.js";

describe("FlamecastClient", () => {
  it("implements acp.Agent interface", () => {
    const client = new FlamecastClient({
      ingressUrl: "http://localhost:18080",
    });

    expect(client.initialize).toBeTypeOf("function");
    expect(client.newSession).toBeTypeOf("function");
    expect(client.prompt).toBeTypeOf("function");
    expect(client.cancel).toBeTypeOf("function");
    expect(client.closeSession).toBeTypeOf("function");
    expect(client.getStatus).toBeTypeOf("function");
    expect(client.resumePermission).toBeTypeOf("function");
    expect(client.dispose).toBeTypeOf("function");
  });
});
