import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatSdkConnector,
  type ChatSdkClient,
  type ChatSdkMessage,
  type ChatSdkThread,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  FlamecastHttpClient,
  InMemoryThreadAgentBindingStore,
  createConnectorMcpServer,
  extractMessageText,
} from "../src/index.js";
import * as pluginEntry from "../src/index.js";

type MentionHandler = (thread: ChatSdkThread, message: ChatSdkMessage) => Promise<void> | void;

function createThread(
  id: string,
  overrides: Partial<{
    post: ChatSdkThread["post"];
    startTyping: NonNullable<ChatSdkThread["startTyping"]>;
    subscribe: NonNullable<ChatSdkThread["subscribe"]>;
    unsubscribe: NonNullable<ChatSdkThread["unsubscribe"]>;
  }> = {},
): ChatSdkThread {
  return {
    id,
    post: overrides.post ?? vi.fn(async () => ({ id: `sent-${id}` })),
    startTyping: overrides.startTyping ?? vi.fn(async () => undefined),
    subscribe: overrides.subscribe ?? vi.fn(async () => undefined),
    unsubscribe: overrides.unsubscribe ?? vi.fn(async () => undefined),
  };
}

function createChatStub() {
  let mentionHandler: MentionHandler | null = null;
  let subscribedHandler: MentionHandler | null = null;
  const slackWebhook = vi.fn(
    async (
      _request: Request,
      options?: { waitUntil?: (task: Promise<unknown>) => void },
    ): Promise<Response> => {
      options?.waitUntil?.(Promise.reject(new Error("ignored")));
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const chat: ChatSdkClient = {
    onNewMention(handler: MentionHandler) {
      mentionHandler = handler;
    },
    onSubscribedMessage(handler: MentionHandler) {
      subscribedHandler = handler;
    },
    webhooks: {
      slack: slackWebhook,
    },
  };

  return {
    chat: {
      ...chat,
    },
    async emitMention(thread: ChatSdkThread, message: ChatSdkMessage) {
      await mentionHandler?.(thread, message);
    },
    async emitSubscribed(thread: ChatSdkThread, message: ChatSdkMessage) {
      await subscribedHandler?.(thread, message);
    },
    slackWebhook,
  };
}

function createFlamecastStub(): FlamecastAgentClient & {
  createAgent: ReturnType<typeof vi.fn>;
  promptAgent: ReturnType<typeof vi.fn>;
  terminateAgent: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  return {
    createAgent: vi.fn(async (_body: FlamecastCreateAgentBody) => ({
      id: `agent-${++counter}`,
    })),
    promptAgent: vi.fn(async () => ({ stopReason: "end_turn" })),
    terminateAgent: vi.fn(async () => undefined),
  };
}

function createAppFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return handler(request);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("InMemoryThreadAgentBindingStore", () => {
  it("stores, updates, deletes, and clears bindings", () => {
    const store = new InMemoryThreadAgentBindingStore();
    const firstThread = createThread("thread-1");

    expect(store.getByThreadId("missing")).toBeNull();
    expect(store.getByAgentId("missing")).toBeNull();
    expect(store.getByAuthToken("missing")).toBeNull();
    expect(store.deleteByThreadId("missing")).toBeNull();

    store.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
      thread: firstThread,
    });

    expect(store.list()).toHaveLength(1);
    expect(store.getByThreadId("thread-1")?.thread).toBe(firstThread);
    expect(store.getByAgentId("agent-1")?.threadId).toBe("thread-1");
    expect(store.getByAuthToken("token-1")?.agentId).toBe("agent-1");

    const nextThread = createThread("thread-1");
    store.set({
      threadId: "thread-1",
      agentId: "agent-2",
      authToken: "token-2",
      thread: nextThread,
    });

    expect(store.getByAgentId("agent-1")).toBeNull();
    expect(store.getByAuthToken("token-1")).toBeNull();
    expect(store.getByThreadId("thread-1")?.thread).toBe(nextThread);

    expect(store.deleteByThreadId("thread-1")?.agentId).toBe("agent-2");
    expect(store.list()).toEqual([]);

    store.set({
      threadId: "thread-2",
      agentId: "agent-3",
      authToken: "token-3",
      thread: createThread("thread-2"),
    });
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it("returns null when secondary indexes point at a missing thread record", () => {
    const store = new InMemoryThreadAgentBindingStore();
    store.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
      thread: createThread("thread-1"),
    });

    const byThreadId = Reflect.get(store, "byThreadId");
    if (!(byThreadId instanceof Map)) {
      throw new Error("Expected byThreadId to be a Map");
    }
    byThreadId.delete("thread-1");

    expect(store.getByAgentId("agent-1")).toBeNull();
    expect(store.getByAuthToken("token-1")).toBeNull();
  });
});

describe("extractMessageText", () => {
  it("extracts text from direct text, content, and parts", () => {
    expect(extractMessageText({ text: " hello " })).toBe("hello");
    expect(extractMessageText({ content: " world " })).toBe("world");
    expect(
      extractMessageText({
        parts: [
          { type: "text", text: "first" },
          { type: "image", text: "ignored" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
    expect(extractMessageText({ content: { type: "json" } })).toBeNull();
    expect(
      extractMessageText({
        parts: [{ type: "text", text: "   " }, { type: "text" }],
      }),
    ).toBeNull();
  });
});

describe("FlamecastHttpClient", () => {
  it("re-exports the plugin entrypoint surface", () => {
    expect(pluginEntry.ChatSdkConnector).toBe(ChatSdkConnector);
    expect(pluginEntry.FlamecastHttpClient).toBe(FlamecastHttpClient);
    expect(pluginEntry.extractMessageText).toBe(extractMessageText);
  });

  it("creates agents, prompts agents, and terminates agents", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "agent-1" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new FlamecastHttpClient({
      baseUrl: "http://flamecast.test",
      fetch: fetchImpl,
    });

    expect(
      await client.createAgent({
        spawn: { command: "node", args: ["agent.js"] },
        cwd: "/workspace",
      }),
    ).toEqual({
      id: "agent-1",
    });
    expect(await client.promptAgent("agent-1", "hello")).toEqual({
      stopReason: "end_turn",
    });
    await client.terminateAgent("agent-1");

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      new URL("/api/agents", "http://flamecast.test"),
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      new URL("/api/agents/agent-1/prompt", "http://flamecast.test"),
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      new URL("/api/agents/agent-1", "http://flamecast.test"),
      { method: "DELETE" },
    );
  });

  it("surfaces JSON and non-JSON error responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "agent failed" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
    );
    const client = new FlamecastHttpClient({
      baseUrl: "http://flamecast.test",
      fetch: fetchImpl,
    });

    await expect(
      client.createAgent({
        spawn: { command: "node" },
        cwd: "/workspace",
      }),
    ).rejects.toThrow("agent failed");
    await expect(client.terminateAgent("agent-1")).rejects.toThrow("Bad Gateway");
  });

  it("uses the global fetch fallback and default MCP header metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const client = new FlamecastHttpClient({
      baseUrl: "http://flamecast.test",
    });

    expect(await client.promptAgent("agent 1", "hello")).toEqual({
      stopReason: "end_turn",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("/api/agents/agent%201/prompt", "http://flamecast.test"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(createConnectorMcpServer("https://connector.test/mcp", "secret")).toEqual({
      type: "http",
      name: "chat-sdk",
      url: "https://connector.test/mcp",
      headers: [{ name: "x-flamecast-chat-token", value: "secret" }],
    });
  });

  it("builds connector MCP server configs", () => {
    expect(
      createConnectorMcpServer("https://connector.test/mcp", "secret", {
        headerName: "x-custom-token",
        serverName: "chat-tools",
      }),
    ).toEqual({
      type: "http",
      name: "chat-tools",
      url: "https://connector.test/mcp",
      headers: [{ name: "x-custom-token", value: "secret" }],
    });
  });

  it("falls back to a synthesized status message for non-json errors without status text", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(new Response("bad gateway", { status: 502, statusText: "" }));
    const client = new FlamecastHttpClient({
      baseUrl: "http://flamecast.test",
      fetch: fetchImpl,
    });

    await expect(client.terminateAgent("agent-1")).rejects.toThrow(
      "Request failed with status 502",
    );
  });
});

describe("ChatSdkConnector", () => {
  it("creates agents on first mention, reuses them for follow-ups, and ignores empty messages", async () => {
    const bindings = new InMemoryThreadAgentBindingStore();
    const chat = createChatStub();
    const flamecast = createFlamecastStub();
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      flamecast,
      bindings,
      agent: {
        spawn: { command: "node", args: ["agent.js"] },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    connector.start();
    connector.start();

    const firstThread = createThread("thread-1");
    await chat.emitMention(firstThread, { text: "hello" });

    expect(firstThread.subscribe).toHaveBeenCalledTimes(1);
    expect(flamecast.createAgent).toHaveBeenCalledTimes(1);
    expect(flamecast.createAgent).toHaveBeenCalledWith({
      spawn: { command: "node", args: ["agent.js"] },
      cwd: "/workspace",
      mcpServers: [
        expect.objectContaining({
          type: "http",
          name: "chat-sdk",
          url: "http://connector.test/mcp",
          headers: [expect.objectContaining({ name: "x-flamecast-chat-token" })],
        }),
      ],
    });
    expect(flamecast.promptAgent).toHaveBeenCalledWith("agent-1", "hello");
    expect(bindings.getByThreadId("thread-1")?.agentId).toBe("agent-1");

    await chat.emitSubscribed(firstThread, { text: "same-thread" });

    const refreshedThread = createThread("thread-1");
    await chat.emitSubscribed(refreshedThread, { content: "follow-up" });
    await chat.emitSubscribed(refreshedThread, { content: { type: "json" } });

    expect(flamecast.createAgent).toHaveBeenCalledTimes(1);
    expect(flamecast.promptAgent).toHaveBeenNthCalledWith(2, "agent-1", "same-thread");
    expect(flamecast.promptAgent).toHaveBeenNthCalledWith(3, "agent-1", "follow-up");
    expect(bindings.getByThreadId("thread-1")?.thread).toBe(refreshedThread);
  });

  it("stops cleanly and continues cleanup when one agent termination fails", async () => {
    const bindings = new InMemoryThreadAgentBindingStore();
    const chat = createChatStub();
    const flamecast = createFlamecastStub();
    flamecast.terminateAgent.mockRejectedValueOnce(new Error("boom"));
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      flamecast,
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    connector.start();
    await chat.emitMention(createThread("thread-1"), { text: "one" });
    await chat.emitMention(createThread("thread-2"), { text: "two" });

    await connector.stop();
    await chat.emitMention(createThread("thread-3"), { text: "ignored" });

    expect(flamecast.terminateAgent).toHaveBeenCalledWith("agent-1");
    expect(flamecast.terminateAgent).toHaveBeenCalledWith("agent-2");
    expect(bindings.list()).toEqual([]);
    expect(flamecast.createAgent).toHaveBeenCalledTimes(2);
  });

  it("serves health and webhook routes", async () => {
    const bindings = new InMemoryThreadAgentBindingStore();
    bindings.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
      thread: createThread("thread-1"),
    });
    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      flamecast: createFlamecastStub(),
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    const health = await connector.fetch(new Request("http://connector.test/health"));
    expect(await health.json()).toEqual({ status: "ok", bindings: 1 });

    const webhook = await connector.fetch(
      new Request("http://connector.test/webhooks/slack", {
        method: "POST",
      }),
    );
    expect(webhook.status).toBe(202);
    expect(await webhook.json()).toEqual({ ok: true });
    expect(chat.slackWebhook).toHaveBeenCalledTimes(1);

    const missing = await connector.fetch(
      new Request("http://connector.test/webhooks/discord", {
        method: "POST",
      }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Unknown webhook platform" });
  });

  it("rejects MCP requests without a valid auth token", async () => {
    const connector = new ChatSdkConnector({
      chat: createChatStub().chat,
      flamecast: createFlamecastStub(),
      bindings: new InMemoryThreadAgentBindingStore(),
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    const missing = await connector.fetch(
      new Request("http://connector.test/mcp", {
        method: "POST",
      }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Missing MCP auth token" });

    const unknown = await connector.fetch(
      new Request("http://connector.test/mcp", {
        method: "POST",
        headers: { "x-flamecast-chat-token": "missing" },
      }),
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "Unknown MCP auth token" });
  });

  it("routes MCP reply, typing, subscribe, and unsubscribe tools to the bound thread", async () => {
    const bindings = new InMemoryThreadAgentBindingStore();
    const flamecast = createFlamecastStub();
    const subscribedThread = createThread("thread-1");
    bindings.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
      thread: subscribedThread,
    });

    const connector = new ChatSdkConnector({
      chat: createChatStub().chat,
      flamecast,
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    const client = new Client({ name: "connector-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL("http://connector.test/mcp"), {
      fetch: createAppFetch(connector.fetch),
      requestInit: {
        headers: {
          "x-flamecast-chat-token": "token-1",
        },
      },
    });

    await client.connect(transport);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "chat.reply",
      "chat.subscribe",
      "chat.typing.start",
      "chat.unsubscribe",
    ]);

    await client.callTool({
      name: "chat.reply",
      arguments: { text: "hello from MCP" },
    });
    await client.callTool({
      name: "chat.typing.start",
      arguments: {},
    });
    await client.callTool({
      name: "chat.subscribe",
      arguments: {},
    });
    await client.callTool({
      name: "chat.unsubscribe",
      arguments: {},
    });

    expect(subscribedThread.post).toHaveBeenCalledWith("hello from MCP");
    expect(subscribedThread.startTyping).toHaveBeenCalledTimes(1);
    expect(subscribedThread.subscribe).toHaveBeenCalledTimes(1);
    expect(subscribedThread.unsubscribe).toHaveBeenCalledTimes(1);
    expect(flamecast.terminateAgent).toHaveBeenCalledWith("agent-1");
    expect(bindings.getByThreadId("thread-1")).toBeNull();

    await transport.close();
  });

  it("treats missing typing support as a no-op", async () => {
    const bindings = new InMemoryThreadAgentBindingStore();
    bindings.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
      thread: createThread("thread-1", {
        startTyping: undefined,
      }),
    });
    const connector = new ChatSdkConnector({
      chat: createChatStub().chat,
      flamecast: createFlamecastStub(),
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    const client = new Client({ name: "connector-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL("http://connector.test/mcp"), {
      fetch: createAppFetch(connector.fetch),
      requestInit: {
        headers: {
          "x-flamecast-chat-token": "token-1",
        },
      },
    });

    await client.connect(transport);
    await expect(
      client.callTool({
        name: "chat.typing.start",
        arguments: {},
      }),
    ).resolves.toBeTruthy();
    await transport.close();
  });
});
