# @flamecast/plugin-chat-sdk

External Chat SDK connector for Flamecast.

This package is meant to run outside Flamecast core. It receives inbound chat
events through Chat SDK, creates or reuses a dedicated Flamecast agent for each
chat thread, and exposes MCP tools so the agent can reply back into that same
thread.

## What It Does

For v1, the connector keeps the model simple:

- one connector process can manage many chat threads
- one chat thread maps to one Flamecast agent
- bindings are kept in memory only
- inbound messages go to Flamecast over the public HTTP API
- outbound chat actions happen through MCP tools
- MCP server registration is HTTP-only (`type: "http"`)

The connector does not scrape assistant text and turn it into a reply. If the
agent wants to respond, it must call an MCP tool such as `chat.reply`.

## Runtime Flow

1. Chat SDK delivers a mention or subscribed-thread message.
2. The connector extracts plain text from the event.
3. If the thread is unbound, the connector:
   - subscribes the thread
   - creates a Flamecast agent via `POST /api/agents`
   - registers one MCP server entry pointing back to this connector's `/mcp`
     endpoint with a per-agent auth header
4. The connector stores the in-memory `threadId -> { agentId, authToken }`
   binding.
5. The connector sends the message text to
   `POST /api/agents/:agentId/prompt`.
6. During the prompt, the Flamecast agent can call:
   - `chat.reply`
   - `chat.typing.start`
   - `chat.subscribe`
   - `chat.unsubscribe`

## HTTP Surface

`ChatSdkConnector` exposes a `fetch` handler. Mount it behind an HTTP server and
route these paths to it:

- `GET /health`
- `POST /webhooks/:platform`
- `ALL /mcp`

`/webhooks/:platform` delegates to the matching Chat SDK webhook handler.
`/mcp` serves the StreamableHTTP MCP endpoint that Flamecast agents call.

## Minimal Usage

```ts
import { serve } from "@hono/node-server";
import {
  ChatSdkConnector,
  FlamecastHttpClient,
  InMemoryThreadAgentBindingStore,
} from "@flamecast/plugin-chat-sdk";

const flamecast = new FlamecastHttpClient({
  baseUrl: "http://127.0.0.1:3001",
});

const connector = new ChatSdkConnector({
  chat,
  flamecast,
  bindings: new InMemoryThreadAgentBindingStore(),
  agent: {
    agentTemplateId: "codex",
  },
  mcpEndpoint: "https://connector.example.com/mcp",
});

connector.start();

serve({
  fetch: connector.fetch,
  port: 3002,
});
```

Expected collaborators:

- `chat` must provide:
  - `onNewMention(handler)`
  - `onSubscribedMessage(handler)`
  - `webhooks[platform](request, { waitUntil })`
- Flamecast must expose:
  - `POST /api/agents`
  - `POST /api/agents/:agentId/prompt`
  - `DELETE /api/agents/:agentId`

## Package Structure

- `src/connector.ts`
  Main orchestration. Installs Chat SDK handlers, manages thread bindings, and
  bridges HTTP webhook traffic and MCP requests.
- `src/flamecast-client.ts`
  Thin typed HTTP client for Flamecast plus the helper that builds the MCP
  server descriptor attached during agent creation.
- `src/mcp.ts`
  Registers the chat MCP tools and serves the StreamableHTTP transport.
- `src/bindings.ts`
  In-memory thread-to-agent binding store and lookup indexes.
- `src/index.ts`
  Public package entrypoint.
- `test/connector.test.ts`
  Package-local tests. Uses fakes only and keeps coverage at 100%.

## MCP Tool Contract

- `chat.reply`
  Posts a visible message to the bound thread.
- `chat.typing.start`
  Starts or refreshes typing in the bound thread if the adapter supports it.
- `chat.subscribe`
  Ensures the thread stays subscribed for follow-up messages.
- `chat.unsubscribe`
  Unsubscribes the thread, removes the binding, and terminates the dedicated
  Flamecast agent.

The tool descriptions instruct the agent to call `chat.typing.start` before
longer reasoning if it expects to send a reply.

## Current Limits

- bindings are not persisted
- connector restart loses thread-to-agent mappings
- there is no reply extraction from ACP text output
- only HTTP MCP registration is supported
- Flamecast is still single-session-per-agent
