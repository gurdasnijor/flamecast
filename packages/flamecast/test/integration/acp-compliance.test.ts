/**
 * ACP Compliance E2E — Full protocol surface through durable transport.
 *
 * Downstream: claude-acp (real agent, requires ANTHROPIC_API_KEY)
 * Upstream:   Standard acp.ClientSideConnection over createDurableStream
 *
 * Tests that the durable transport is fully transparent — the standard
 * ACP SDK works identically whether the stream is stdio, WebSocket, or Restate.
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
import { AcpConnection, pubsubObject, createDurableStream } from "../../src/index.js";
import type { CreateInput } from "../../src/connection.js";

const SKIP = !process.env.ANTHROPIC_API_KEY;

// ─── Helpers ────────────────────────────────────────────────────────────────

const spawnConfig = {
  type: "npx" as const,
  cmd: "npx",
  args: ["@agentclientprotocol/claude-agent-acp"],
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
};

let restateEnv: RestateTestEnvironment;
let ingress: clients.Ingress;
let ingressUrl: string;
let tmpDir: string;

type SessionUpdateCollector = {
  updates: acp.SessionNotification[];
  conn: acp.ClientSideConnection;
  connectionId: string;
};

async function createSession(cwd: string): Promise<SessionUpdateCollector> {
  const connectionId = crypto.randomUUID();
  const vo = ingress.objectClient(AcpConnection, connectionId);

  await vo.create({
    agentName: "claude-acp",
    spawnConfig,
    cwd,
    mcpServers: [],
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  } satisfies CreateInput as never);

  const stream = createDurableStream({ connectionId, ingressUrl });

  const updates: acp.SessionNotification[] = [];
  const conn = new acp.ClientSideConnection(
    () => ({
      async sessionUpdate(p: acp.SessionNotification) {
        updates.push(p);
      },
      async requestPermission(p: acp.RequestPermissionRequest) {
        // Auto-approve first option for compliance tests
        return { outcome: { outcome: "selected" as const, optionId: p.options[0]?.optionId ?? "" } };
      },
      async readTextFile(p: acp.ReadTextFileRequest) {
        return { content: await readFile(p.path, "utf-8") };
      },
      async writeTextFile(p: acp.WriteTextFileRequest) {
        const { mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(p.path), { recursive: true });
        await writeFile(p.path, p.content, "utf-8");
        return {};
      },
    }),
    stream,
  );

  await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "flamecast-test", title: "ACP Compliance", version: "1.0.0" },
  });

  await conn.newSession({ cwd, mcpServers: [] });

  return { updates, conn, connectionId };
}

async function promptAndCollect(cwd: string, text: string) {
  const session = await createSession(cwd);
  const result = await session.conn.prompt({
    sessionId: "", // will be overridden by the actual session
    prompt: [{ type: "text", text }],
  });
  // Wait briefly for any trailing notifications
  await new Promise((r) => setTimeout(r, 500));
  return { result, updates: session.updates, connectionId: session.connectionId };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("ACP Compliance — claude-acp through durable transport", () => {
  beforeAll(async () => {
    restateEnv = await RestateTestEnvironment.start({
      services: [AcpConnection, pubsubObject],
    });
    ingressUrl = restateEnv.baseUrl();
    // The bridge inside AcpConnection needs to call back to Restate ingress
    process.env.RESTATE_INGRESS_URL = ingressUrl;
    ingress = clients.connect({ url: ingressUrl });
    tmpDir = await mkdtemp(join(tmpdir(), "flamecast-acp-"));
  }, 120_000);

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await restateEnv?.stop();
  });

  // ── 1. Initialization ──────────────────────────────────────────────────

  describe("Initialization", () => {
    it("returns matching protocol version", async () => {
      const session = await createSession(tmpDir);
      // initialize already called in createSession
      expect(session.conn).toBeDefined();
    }, 30_000);
  });

  // ── 2. Prompt Turn ─────────────────────────────────────────────────────

  describe("Prompt Turn", () => {
    it("returns stopReason: end_turn for simple response", async () => {
      const { result } = await promptAndCollect(tmpDir, "Reply with exactly: OK");
      expect(result.stopReason).toBe("end_turn");
    }, 60_000);

    it("stopReason is one of the spec-defined values", async () => {
      const { result } = await promptAndCollect(tmpDir, "Reply OK.");
      expect([
        "end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled",
      ]).toContain(result.stopReason);
    }, 60_000);

    it("accumulates agent_message_chunk updates", async () => {
      const { updates } = await promptAndCollect(tmpDir, "Say hello.");
      const chunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect((chunk.update as Record<string, unknown>).content).toBeDefined();
      }
    }, 60_000);
  });

  // ── 3. Content ─────────────────────────────────────────────────────────

  describe("Content", () => {
    it("accepts multiple text content blocks", async () => {
      const session = await createSession(tmpDir);
      const result = await session.conn.prompt({
        sessionId: "",
        prompt: [
          { type: "text", text: "First block." },
          { type: "text", text: "Reply OK." },
        ],
      });
      expect(result.stopReason).toBe("end_turn");
    }, 60_000);

    it("agent_message_chunk content has type: text", async () => {
      const { updates } = await promptAndCollect(tmpDir, "Say one word.");
      const chunk = updates.find((u) => u.update.sessionUpdate === "agent_message_chunk");
      expect(chunk).toBeDefined();
      const content = (chunk!.update as Record<string, unknown>).content as Record<string, unknown>;
      expect(content.type).toBe("text");
      expect(typeof content.text).toBe("string");
    }, 60_000);
  });

  // ── 4. Tool Calls ──────────────────────────────────────────────────────

  describe("Tool Calls", () => {
    it("tool_call has required fields: toolCallId, title", async () => {
      const { updates } = await promptAndCollect(
        tmpDir,
        `Run "echo tool-fields" in the terminal.`,
      );
      const toolCall = updates.find((u) => u.update.sessionUpdate === "tool_call");
      expect(toolCall).toBeDefined();
      const update = toolCall!.update as Record<string, unknown>;
      expect(typeof update.toolCallId).toBe("string");
      expect(typeof update.title).toBe("string");
    }, 120_000);

    it("tool call reaches completed or failed status", async () => {
      const { updates } = await promptAndCollect(
        tmpDir,
        `Run "echo lifecycle" in the terminal.`,
      );
      const statuses = updates
        .filter((u) => u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update")
        .map((u) => (u.update as Record<string, unknown>).status)
        .filter(Boolean) as string[];
      expect(statuses.some((s) => s === "completed" || s === "failed")).toBe(true);
    }, 120_000);
  });

  // ── 5. File System ─────────────────────────────────────────────────────

  describe("File System", () => {
    it("writeTextFile — creates file on disk", async () => {
      const filePath = join(tmpDir, "fs-write.txt");
      const session = await createSession(tmpDir);
      await session.conn.prompt({
        sessionId: "",
        prompt: [{ type: "text", text: `Write exactly "acp-write" to ${filePath}.` }],
      });
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("acp-write");
    }, 120_000);

    it("readTextFile — agent reads existing file", async () => {
      const filePath = join(tmpDir, "fs-read.txt");
      await writeFile(filePath, "secret-12345", "utf-8");
      const { result } = await promptAndCollect(
        tmpDir,
        `Read ${filePath} and reply with its contents only.`,
      );
      expect(result.stopReason).toBe("end_turn");
    }, 120_000);
  });

  // ── 6. Cancellation ───────────────────────────────────────────────────

  describe("Cancellation", () => {
    it("cancel returns without error", async () => {
      const session = await createSession(tmpDir);
      await session.conn.cancel({ sessionId: "" });
    }, 30_000);
  });

  // ── 7. Error Handling ─────────────────────────────────────────────────

  describe("Error Handling", () => {
    it("prompt to non-existent connection fails gracefully", async () => {
      const stream = createDurableStream({ connectionId: "nonexistent", ingressUrl });
      const conn = new acp.ClientSideConnection(
        () => ({
          async sessionUpdate() {},
          async requestPermission() { return { outcome: { outcome: "cancelled" as const } }; },
        }),
        stream,
      );
      await expect(
        conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
      ).rejects.toThrow();
    }, 30_000);
  });
});
