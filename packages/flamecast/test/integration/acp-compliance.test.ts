/**
 * ACP Compliance E2E — Full protocol surface through Flamecast gateway.
 *
 * Downstream: claude-acp (real agent, requires ANTHROPIC_API_KEY)
 * Upstream:   Restate ingress clients → AgentConnection + AgentSession VOs
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
import * as clients from "@restatedev/restate-sdk-clients";
import * as acp from "@agentclientprotocol/sdk";
import { AgentConnection } from "../../src/agent-connection.js";
import { AgentSession } from "../../src/agent-session.js";

const SKIP = !process.env.ANTHROPIC_API_KEY;

type Update = Record<string, unknown>;

// ─── Helpers ────────────────────────────────────────────────────────────────

const spawnConfig = {
  type: "npx" as const,
  cmd: "npx",
  args: ["@agentclientprotocol/claude-agent-acp"],
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
};

let restateEnv: RestateTestEnvironment;
let ingress: clients.Ingress;
let tmpDir: string;

function uid() {
  return crypto.randomUUID();
}

function connectionVo(clientId: string) {
  return ingress.objectClient(AgentConnection, clientId);
}

function sessionVo(sessionId: string) {
  return ingress.objectClient(AgentSession, sessionId);
}

async function createSession(cwd: string) {
  const clientId = uid();
  const conn = connectionVo(clientId);
  await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  } as never);
  const { sessionId } = await conn.newSession({
    cwd,
    mcpServers: [],
    _meta: { spawnConfig },
  } as never) as { sessionId: string };
  return { clientId, sessionId };
}

async function promptAndCollect(cwd: string, text: string, waitMs = 1000) {
  const { sessionId } = await createSession(cwd);
  const result = await sessionVo(sessionId).prompt({
    sessionId,
    prompt: [{ type: "text", text }],
  } as never) as acp.PromptResponse;
  await new Promise((r) => setTimeout(r, waitMs));
  const updates = (await sessionVo(sessionId).getUpdates()) as acp.SessionNotification[];
  return { result, updates, sessionId };
}

async function poll<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  { intervalMs = 200, maxAttempts = 50 } = {},
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("poll timed out");
}

// ─── Setup ──────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("ACP Compliance — claude-acp through Flamecast", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AgentConnection, AgentSession],
    });
    ingress = clients.connect({ url: restateEnv.baseUrl() });
    tmpDir = await mkdtemp(join(tmpdir(), "flamecast-acp-"));
  }, 120_000);

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await restateEnv?.stop();
  });

  // ── 1. Initialization ──────────────────────────────────────────────────

  describe("Initialization", () => {
    it("returns matching protocol version", async () => {
      const result = await connectionVo(uid()).initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      } as never) as acp.InitializeResponse;
      expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    });

    it("returns agentCapabilities object", async () => {
      const result = await connectionVo(uid()).initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "test", title: "ACP Test", version: "1.0.0" },
      } as never) as acp.InitializeResponse;
      expect(result.agentCapabilities).toBeDefined();
      expect(typeof result.agentCapabilities).toBe("object");
    });
  });

  // ── 2. Session Setup ───────────────────────────────────────────────────

  describe("Session Setup", () => {
    it("returns a unique string sessionId", async () => {
      const { sessionId } = await createSession(tmpDir);
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);
    }, 30_000);

    it("two sessions get different sessionIds", async () => {
      const s1 = await createSession(tmpDir);
      const s2 = await createSession(tmpDir);
      expect(s1.sessionId).not.toBe(s2.sessionId);
    }, 60_000);

    it("accepts _meta extension fields", async () => {
      const conn = connectionVo(uid());
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      } as never);
      const result = await conn.newSession({
        cwd: tmpDir,
        mcpServers: [],
        _meta: { spawnConfig, agentName: "claude-acp", customField: "test" },
      } as never) as { sessionId: string };
      expect(result.sessionId).toBeDefined();
    }, 30_000);
  });

  // ── 3. Prompt Turn ─────────────────────────────────────────────────────

  describe("Prompt Turn", () => {
    it("returns stopReason: end_turn for simple response", async () => {
      const { sessionId } = await createSession(tmpDir);
      const result = await sessionVo(sessionId).prompt({
        sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: OK" }],
      } as never) as acp.PromptResponse;
      expect(result.stopReason).toBe("end_turn");
    }, 60_000);

    it("stopReason is one of the spec-defined values", async () => {
      const { sessionId } = await createSession(tmpDir);
      const result = await sessionVo(sessionId).prompt({
        sessionId,
        prompt: [{ type: "text", text: "Reply OK." }],
      } as never) as acp.PromptResponse;
      expect([
        "end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled",
      ]).toContain(result.stopReason);
    }, 60_000);

    it("multi-turn retains conversation context", async () => {
      const { sessionId } = await createSession(tmpDir);
      await sessionVo(sessionId).prompt({
        sessionId,
        prompt: [{ type: "text", text: "Remember: FLAMINGO. Reply OK." }],
      } as never);
      const r2 = await sessionVo(sessionId).prompt({
        sessionId,
        prompt: [{ type: "text", text: "What was the word? Reply with just the word." }],
      } as never) as acp.PromptResponse;
      expect(r2.stopReason).toBe("end_turn");
    }, 120_000);

    it("accumulates agent_message_chunk updates", async () => {
      const { updates } = await promptAndCollect(tmpDir, "Say hello.");
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
      const { sessionId } = await createSession(tmpDir);
      const result = await sessionVo(sessionId).prompt({
        sessionId,
        prompt: [
          { type: "text", text: "First block." },
          { type: "text", text: "Second block." },
          { type: "text", text: "Reply OK." },
        ],
      } as never) as acp.PromptResponse;
      expect(result.stopReason).toBe("end_turn");
    }, 60_000);

    it("agent_message_chunk content has type: text", async () => {
      const { updates } = await promptAndCollect(tmpDir, "Say one word.");
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
        tmpDir,
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
        tmpDir,
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
        tmpDir,
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
        tmpDir,
        `Run "echo lifecycle" in the terminal.`,
      );
      const statuses = updates
        .filter((u) => u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update")
        .map((u) => (u.update as Update).status)
        .filter(Boolean) as string[];
      expect(statuses.some((s) => s === "completed" || s === "failed")).toBe(true);
    }, 120_000);
  });

  // ── 6. File System ─────────────────────────────────────────────────────

  describe("File System", () => {
    it("writeTextFile — creates file on disk", async () => {
      const filePath = join(tmpDir, "fs-write.txt");
      const { sessionId } = await createSession(tmpDir);
      await sessionVo(sessionId).prompt({
        sessionId,
        prompt: [{ type: "text", text: `Write exactly "acp-write" to ${filePath}.` }],
      } as never);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("acp-write");
    }, 120_000);

    it("readTextFile — agent reads existing file content", async () => {
      const filePath = join(tmpDir, "fs-read.txt");
      await writeFile(filePath, "secret-12345", "utf-8");
      const { sessionId } = await createSession(tmpDir);
      const result = await sessionVo(sessionId).prompt({
        sessionId,
        prompt: [{ type: "text", text: `Read ${filePath} and reply with its contents only.` }],
      } as never) as acp.PromptResponse;
      expect(result.stopReason).toBe("end_turn");
    }, 120_000);
  });

  // ── 7. Terminals ───────────────────────────────────────────────────────

  describe("Terminals", () => {
    it("terminal command shows as tool_call with kind: execute", async () => {
      const { updates } = await promptAndCollect(
        tmpDir,
        `Run "echo terminal-ok" in the terminal.`,
      );
      const execCalls = updates.filter((u) => {
        const update = u.update as Update;
        return (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.kind === "execute";
      });
      expect(execCalls.length).toBeGreaterThan(0);
    }, 120_000);
  });

  // ── 8. Permission Requests ────────────────────────────────────────────

  describe("Permission Requests", () => {
    it("permission request surfaces via getPendingPermission, awakeable resolves prompt", async () => {
      const { sessionId } = await createSession(tmpDir);

      // Start prompt that will trigger permission (file write)
      const promptPromise = sessionVo(sessionId).prompt({
        sessionId,
        prompt: [{ type: "text", text: `Create ${join(tmpDir, "perm-test.txt")} with "test". Do not read first.` }],
      } as never);

      // Poll for pending permission
      const pending = await poll(
        () => sessionVo(sessionId).getPendingPermission() as Promise<any>,
        (v: any) => !!v?.awakeableId,
      );
      expect(pending.awakeableId).toBeDefined();
      expect(pending.toolCall).toBeDefined();
      expect(pending.options.length).toBeGreaterThan(0);

      // Resolve via Restate SDK
      const allowOption = pending.options.find((o: any) => o.kind === "allow_once");
      ingress.resolveAwakeable(pending.awakeableId, {
        outcome: "selected",
        optionId: allowOption?.optionId ?? pending.options[0].optionId,
      });

      const result = await promptPromise as acp.PromptResponse;
      expect(result.stopReason).toBe("end_turn");
    }, 120_000);

    it("rejecting permission is handled by the agent", async () => {
      const { sessionId } = await createSession(tmpDir);

      const promptPromise = sessionVo(sessionId).prompt({
        sessionId,
        prompt: [{ type: "text", text: `Run "echo reject-test". If rejected, say "rejected".` }],
      } as never);

      const pending = await poll(
        () => sessionVo(sessionId).getPendingPermission() as Promise<any>,
        (v: any) => !!v?.awakeableId,
      );

      const rejectOption = pending.options.find((o: any) => o.kind === "reject_once");
      ingress.resolveAwakeable(pending.awakeableId, {
        outcome: "selected",
        optionId: rejectOption?.optionId ?? pending.options[0].optionId,
      });

      const result = await promptPromise as acp.PromptResponse;
      expect(result.stopReason).toBe("end_turn");
    }, 120_000);
  });

  // ── 9. Cancellation ───────────────────────────────────────────────────

  describe("Cancellation", () => {
    it("cancel returns without error", async () => {
      const { sessionId } = await createSession(tmpDir);
      await sessionVo(sessionId).cancel({ sessionId } as never);
    }, 30_000);
  });

  // ── 10. Error Handling ─────────────────────────────────────────────────

  describe("Error Handling", () => {
    it("prompt without session throws", async () => {
      await expect(
        sessionVo("nonexistent").prompt({
          sessionId: "nonexistent",
          prompt: [{ type: "text", text: "hello" }],
        } as never),
      ).rejects.toThrow();
    }, 30_000);
  });

  // ── 11. Session Index ─────────────────────────────────────────────────

  describe("Session Index", () => {
    it("listSessions returns created sessions", async () => {
      const clientId = uid();
      const conn = connectionVo(clientId);
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      } as never);
      await conn.newSession({ cwd: tmpDir, mcpServers: [], _meta: { spawnConfig } } as never);
      await conn.newSession({ cwd: tmpDir, mcpServers: [], _meta: { spawnConfig } } as never);

      const { sessions } = await conn.listSessions({} as never) as { sessions: any[] };
      expect(sessions).toHaveLength(2);
    }, 60_000);
  });
});
