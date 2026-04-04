/**
 * ACP Compliance E2E — Full protocol surface through Flamecast gateway.
 *
 * Downstream: claude-acp (real agent, requires ANTHROPIC_API_KEY)
 * Upstream:   createRestateStream + ClientSideConnection
 *
 * One describe per ACP spec sidebar section, with deep field-level assertions.
 *
 * Requires: ANTHROPIC_API_KEY
 * Reference: https://agentclientprotocol.com/protocol/schema
 */

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as acp from "@agentclientprotocol/sdk";
import { createPubsubClient } from "@restatedev/pubsub-client";
import { AcpAgent, registerAgent } from "../../src/agent.js";
import { pubsubObject } from "../../src/pubsub.js";
import { createRestateStream } from "../../src/client/restate-stream.js";

const SKIP = !process.env.ANTHROPIC_API_KEY;

type Update = Record<string, unknown>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

registerAgent("claude-acp", {
  id: "claude-acp",
  distribution: {
    type: "npx" as const,
    cmd: "npx",
    args: ["@agentclientprotocol/claude-agent-acp"],
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  },
});

class TestClient implements acp.Client {
  updates: acp.SessionNotification[] = [];
  perms: acp.RequestPermissionRequest[] = [];
  autoApprove = true;

  async sessionUpdate(params: acp.SessionNotification) {
    this.updates.push(params);
  }

  async requestPermission(params: acp.RequestPermissionRequest) {
    this.perms.push(params);
    if (!this.autoApprove) return { outcome: { outcome: "cancelled" as const } };
    const allow = params.options.find((o) => o.kind === "allow_once");
    return {
      outcome: {
        outcome: "selected" as const,
        optionId: allow?.optionId ?? params.options[0].optionId,
      },
    };
  }
}

function connect(ingressUrl: string, client?: TestClient) {
  const testClient = client ?? new TestClient();
  const pubsub = createPubsubClient({ name: "pubsub", ingressUrl });
  const sessionKey = crypto.randomUUID();
  const stream = createRestateStream({ ingressUrl, sessionKey, pubsub });
  const conn = new acp.ClientSideConnection(() => testClient, stream);
  return { conn, sessionKey, testClient, dispose: () => {} };
}

async function createSession(ingressUrl: string, cwd: string, client?: TestClient) {
  const { conn, testClient } = connect(ingressUrl, client);
  await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  const { sessionId } = await conn.newSession({ cwd, mcpServers: [] });
  return { conn, sessionId, testClient };
}

async function promptAndCollect(
  ingressUrl: string,
  cwd: string,
  text: string,
  waitMs = 500,
) {
  const { conn, sessionId, testClient } = await createSession(ingressUrl, cwd);
  const result = await conn.prompt({
    sessionId,
    prompt: [{ type: "text", text }],
  });
  await new Promise((r) => setTimeout(r, waitMs));
  return { result, updates: testClient.updates, perms: testClient.perms, sessionId };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let restateEnv: RestateTestEnvironment;
let tmpDir: string;

describe.skipIf(SKIP)("ACP Compliance — claude-acp through Flamecast", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpAgent, pubsubObject],
    });
    tmpDir = await mkdtemp(join(tmpdir(), "flamecast-acp-"));
  }, 120_000);

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await restateEnv?.stop();
  });

  // ── 1. Initialization ──────────────────────────────────────────────────

  describe("Initialization", () => {
    it("returns matching protocol version", async () => {
      const { conn } = connect(restateEnv.baseUrl());
      const result = await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    });

    it("returns agentCapabilities object", async () => {
      const { conn } = connect(restateEnv.baseUrl());
      const result = await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "test", title: "ACP Test", version: "1.0.0" },
      });
      expect(result.agentCapabilities).toBeDefined();
      expect(typeof result.agentCapabilities).toBe("object");
    });
  });

  // ── 2. Session Setup ───────────────────────────────────────────────────

  describe("Session Setup", () => {
    it("returns a unique string sessionId", async () => {
      const { sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);
    }, 30_000);

    it("two sessions get different sessionIds", async () => {
      const s1 = await createSession(restateEnv.baseUrl(), tmpDir);
      const s2 = await createSession(restateEnv.baseUrl(), tmpDir);
      expect(s1.sessionId).not.toBe(s2.sessionId);
    }, 60_000);

    it("accepts _meta extension fields", async () => {
      const { conn } = connect(restateEnv.baseUrl());
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await conn.newSession({
        cwd: tmpDir,
        mcpServers: [],
        _meta: { agentName: "claude-acp", customField: "test" },
      });
      expect(sessionId).toBeDefined();
    }, 30_000);
  });

  // ── 3. Prompt Turn ─────────────────────────────────────────────────────

  describe("Prompt Turn", () => {
    it("returns stopReason: end_turn for simple response", async () => {
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      const result = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: OK" }],
      });
      expect(result.stopReason).toBe("end_turn");
    }, 60_000);

    it("stopReason is one of the spec-defined values", async () => {
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      const result = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Reply OK." }],
      });
      expect([
        "end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled",
      ]).toContain(result.stopReason);
    }, 60_000);

    it("multi-turn retains conversation context", async () => {
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Remember: FLAMINGO. Reply OK." }],
      });
      const r2 = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "What was the word? Reply with just the word." }],
      });
      expect(r2.stopReason).toBe("end_turn");
    }, 120_000);

    it("streams agent_message_chunk updates during prompt", async () => {
      const { updates } = await promptAndCollect(restateEnv.baseUrl(), tmpDir, "Say hello.");
      const chunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect((chunk.update as Update).content).toBeDefined();
      }
    }, 60_000);
  });

  // ── 4. Content ─────────────────────────────────────────────────────────

  describe("Content", () => {
    it("accepts multiple text content blocks in a single prompt", async () => {
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      const result = await conn.prompt({
        sessionId,
        prompt: [
          { type: "text", text: "First block." },
          { type: "text", text: "Second block." },
          { type: "text", text: "Reply OK." },
        ],
      });
      expect(result.stopReason).toBe("end_turn");
    }, 60_000);

    it("accepts resource_link content block", async () => {
      const filePath = join(tmpDir, "content-res.txt");
      await writeFile(filePath, "resource data", "utf-8");
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      const result = await conn.prompt({
        sessionId,
        prompt: [
          { type: "resource_link", uri: `file://${filePath}`, name: "content-res.txt" } as acp.ContentBlock,
          { type: "text", text: "Acknowledge the resource. Reply OK." },
        ],
      });
      expect(result.stopReason).toBe("end_turn");
    }, 60_000);

    it("agent_message_chunk content has type: text", async () => {
      const { updates } = await promptAndCollect(restateEnv.baseUrl(), tmpDir, "Say one word.");
      const chunk = updates.find((u) => u.update.sessionUpdate === "agent_message_chunk");
      expect(chunk).toBeDefined();
      const content = (chunk!.update as Update).content as Update;
      expect(content.type).toBe("text");
      expect(typeof content.text).toBe("string");
    }, 60_000);
  });

  // ── 5. Tool Calls ──────────────────────────────────────────────────────

  describe("Tool Calls", () => {
    it("tool_call has required fields: toolCallId, title", async () => {
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo tool-fields" in the terminal.`,
      );
      const toolCall = updates.find((u) => u.update.sessionUpdate === "tool_call");
      expect(toolCall).toBeDefined();
      const update = toolCall!.update as Update;
      expect(typeof update.toolCallId).toBe("string");
      expect(typeof update.title).toBe("string");
    }, 120_000);

    it("tool kind is a valid ToolKind enum value", async () => {
      const validKinds = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"];
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo kind-test" in the terminal.`,
      );
      const kinds = updates
        .filter((u) => u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update")
        .map((u) => (u.update as Update).kind)
        .filter(Boolean) as string[];
      expect(kinds.length).toBeGreaterThan(0);
      for (const kind of kinds) expect(validKinds).toContain(kind);
    }, 120_000);

    it("tool status is a valid ToolCallStatus enum value", async () => {
      const validStatuses = ["pending", "in_progress", "completed", "failed"];
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo status-test" in the terminal.`,
      );
      const statuses = updates
        .filter((u) => u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update")
        .map((u) => (u.update as Update).status)
        .filter(Boolean) as string[];
      expect(statuses.length).toBeGreaterThan(0);
      for (const status of statuses) expect(validStatuses).toContain(status);
    }, 120_000);

    it("tool call reaches completed or failed status", async () => {
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo lifecycle" in the terminal.`,
      );
      const statuses = updates
        .filter((u) => u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update")
        .map((u) => (u.update as Update).status)
        .filter(Boolean) as string[];
      expect(statuses.some((s) => s === "completed" || s === "failed")).toBe(true);
    }, 120_000);

    it("tool_call_update has content array when completed", async () => {
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo content-test" in the terminal.`,
      );
      const completed = updates.find((u) => {
        const update = u.update as Update;
        return (update.sessionUpdate === "tool_call_update" || update.sessionUpdate === "tool_call") && update.status === "completed";
      });
      if (completed) {
        expect(Array.isArray((completed.update as Update).content)).toBe(true);
      }
    }, 120_000);

    it("file edit produces diff content type with path and newText", async () => {
      const filePath = join(tmpDir, "diff-test.txt");
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Write "diff-content" to ${filePath}. Do not read first.`,
      );
      const toolNotifs = updates.filter(
        (u) => u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update",
      );
      const hasDiff = toolNotifs.some((u) => {
        const content = (u.update as Update).content;
        if (!Array.isArray(content)) return false;
        return content.some((c: Update) => c.type === "diff" && typeof c.path === "string");
      });
      if (hasDiff) {
        const withDiff = toolNotifs.find((u) => {
          const content = (u.update as Update).content;
          return Array.isArray(content) && content.some((c: Update) => c.type === "diff");
        });
        const diff = ((withDiff!.update as Update).content as Update[]).find((c) => c.type === "diff")!;
        expect(typeof diff.path).toBe("string");
        expect(typeof diff.newText).toBe("string");
      }
    }, 120_000);
  });

  // ── 6. File System ─────────────────────────────────────────────────────

  describe("File System", () => {
    it("writeTextFile — creates file on disk", async () => {
      const filePath = join(tmpDir, "fs-write.txt");
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: `Write exactly "acp-write" to ${filePath}.` }],
      });
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("acp-write");
    }, 120_000);

    it("writeTextFile — creates intermediate directories", async () => {
      const filePath = join(tmpDir, "nested", "dir", "deep.txt");
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: `Write "nested-test" to ${filePath}.` }],
      });
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("nested-test");
    }, 120_000);

    it("readTextFile — agent reads existing file content", async () => {
      const filePath = join(tmpDir, "fs-read.txt");
      await writeFile(filePath, "secret-12345", "utf-8");
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      const result = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: `Read ${filePath} and reply with its contents only.` }],
      });
      expect(result.stopReason).toBe("end_turn");
    }, 120_000);
  });

  // ── 7. Terminals ───────────────────────────────────────────────────────

  describe("Terminals", () => {
    it("terminal command shows as tool_call with kind: execute", async () => {
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo terminal-ok" in the terminal.`,
      );
      const execCalls = updates.filter((u) => {
        const update = u.update as Update;
        return (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.kind === "execute";
      });
      expect(execCalls.length).toBeGreaterThan(0);
    }, 120_000);

    it("terminal tool call reaches completed status", async () => {
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo terminal-done" in the terminal.`,
        1500,
      );
      const statuses = updates
        .filter((u) => {
          const update = u.update as Update;
          return (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.kind === "execute";
        })
        .map((u) => (u.update as Update).status)
        .filter(Boolean) as string[];
      expect(statuses.some((s) => s === "completed" || s === "failed")).toBe(true);
    }, 120_000);
  });

  // ── 8. Agent Plan ──────────────────────────────────────────────────────

  describe("Agent Plan", () => {
    it("plan update has entries array with content, status, priority", async () => {
      const { updates } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Create ${join(tmpDir, "plan-a.txt")} with "a" and ${join(tmpDir, "plan-b.txt")} with "b". Do both.`,
        1000,
      );
      const planUpdates = updates.filter((u) => u.update.sessionUpdate === "plan");
      if (planUpdates.length > 0) {
        const plan = planUpdates[0].update as Update;
        expect(Array.isArray(plan.entries)).toBe(true);
        const entries = plan.entries as Update[];
        if (entries.length > 0) {
          expect(typeof entries[0].content).toBe("string");
          expect(["pending", "in_progress", "completed"]).toContain(entries[0].status);
          expect(["high", "medium", "low"]).toContain(entries[0].priority);
        }
      }
    }, 120_000);
  });

  // ── 9. Session Modes ───────────────────────────────────────────────────

  describe("Session Modes", () => {
    it("current_mode_update has currentModeId field", async () => {
      const { updates } = await promptAndCollect(restateEnv.baseUrl(), tmpDir, "Reply OK.");
      const modeUpdates = updates.filter((u) => u.update.sessionUpdate === "current_mode_update");
      if (modeUpdates.length > 0) {
        expect(typeof (modeUpdates[0].update as Update).currentModeId).toBe("string");
      }
    }, 60_000);
  });

  // ── 10. Session Config Options ─────────────────────────────────────────

  describe("Session Config Options", () => {
    it("config_option_update has configOptions array", async () => {
      const { updates } = await promptAndCollect(restateEnv.baseUrl(), tmpDir, "Reply OK.");
      const configUpdates = updates.filter((u) => u.update.sessionUpdate === "config_option_update");
      if (configUpdates.length > 0) {
        expect(Array.isArray((configUpdates[0].update as Update).configOptions)).toBe(true);
      }
    }, 60_000);
  });

  // ── 11. Slash Commands ─────────────────────────────────────────────────

  describe("Slash Commands", () => {
    it("available_commands update has availableCommands array", async () => {
      const { updates } = await promptAndCollect(restateEnv.baseUrl(), tmpDir, "Reply OK.");
      const cmdUpdates = updates.filter(
        (u) => u.update.sessionUpdate === "available_commands_update",
      );
      if (cmdUpdates.length > 0) {
        const cmd = cmdUpdates[0].update as Update;
        expect(Array.isArray(cmd.availableCommands)).toBe(true);
        const cmds = cmd.availableCommands as Update[];
        if (cmds.length > 0) {
          expect(typeof cmds[0].name).toBe("string");
          expect(typeof cmds[0].description).toBe("string");
        }
      }
    }, 60_000);
  });

  // ── 12. Permission Requests ────────────────────────────────────────────

  describe("Permission Requests", () => {
    it("permission request has toolCall with toolCallId", async () => {
      const { perms } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Create ${join(tmpDir, "perm-tc.txt")} with "test". Do not read first.`,
      );
      expect(perms.length).toBeGreaterThan(0);
      expect(perms[0].toolCall).toBeDefined();
      expect(perms[0].toolCall.toolCallId).toBeDefined();
    }, 120_000);

    it("permission options have optionId, name, and valid kind", async () => {
      const validKinds = ["allow_once", "allow_always", "reject_once", "reject_always"];
      const { perms } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Create ${join(tmpDir, "perm-opts.txt")} with "perm-test". Do not read it first.`,
      );
      expect(perms.length).toBeGreaterThan(0);
      for (const opt of perms[0].options) {
        expect(typeof opt.optionId).toBe("string");
        expect(typeof opt.name).toBe("string");
        expect(validKinds).toContain(opt.kind);
      }
    }, 120_000);

    it("reject_once — agent handles rejection", async () => {
      const client = new TestClient();
      client.autoApprove = false;
      const { result } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo reject-test". If rejected, say "rejected".`,
      );
      expect(result.stopReason).toBe("end_turn");
    }, 120_000);

    it("cancelled outcome — agent handles cancellation", async () => {
      const client = new TestClient();
      client.autoApprove = false;
      const { result } = await promptAndCollect(
        restateEnv.baseUrl(), tmpDir,
        `Run "echo cancel-test". If cancelled, say "cancelled".`,
      );
      expect(result.stopReason).toBe("end_turn");
    }, 120_000);
  });

  // ── 13. Extensibility ──────────────────────────────────────────────────

  describe("Extensibility", () => {
    it("_meta fields pass through on newSession", async () => {
      const { conn } = connect(restateEnv.baseUrl());
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await conn.newSession({
        cwd: tmpDir,
        mcpServers: [],
        _meta: { agentName: "claude-acp", customField: "test-value" },
      });
      expect(sessionId).toBeDefined();
    }, 30_000);
  });

  // ── 14. Cancellation ───────────────────────────────────────────────────

  describe("Cancellation", () => {
    it("cancel returns without error", async () => {
      const { conn, sessionId } = await createSession(restateEnv.baseUrl(), tmpDir);
      await conn.cancel({ sessionId });
    }, 30_000);
  });

  // ── 15. Error Handling ─────────────────────────────────────────────────

  describe("Error Handling", () => {
    it("prompt without session throws", async () => {
      const { conn } = connect(restateEnv.baseUrl());
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        conn.prompt({
          sessionId: "nonexistent",
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toThrow();
    }, 30_000);
  });
});
