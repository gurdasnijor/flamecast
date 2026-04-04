/**
 * Smoke test — verifies the two VOs are importable and have the expected shape.
 */

import { describe, it, expect } from "vitest";
import { AgentConnection } from "../../src/agent-connection.js";
import { AgentSession } from "../../src/agent-session.js";

describe("VO exports", () => {
  it("AgentConnection has name property", () => {
    expect(AgentConnection.name).toBe("AgentConnection");
  });

  it("AgentSession has name property", () => {
    expect(AgentSession.name).toBe("AgentSession");
  });
});
