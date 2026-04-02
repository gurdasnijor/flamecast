# Flamecast

Flamecast is an open-source, self-hostable control plane for ACP-compatible agents. It manages durable agent sessions via [Restate](https://restate.dev/) Virtual Objects, brokers permission requests through awakeables, streams events via SSE, and ships a React UI.

---

## Quick start

```bash
pnpm install
pnpm dev
```

Open **http://localhost:3000**. Select an agent template and click **Start session**.

---

## Stack

| Layer | Technology |
|---|---|
| Control plane | `Flamecast` class + Hono API |
| Session orchestration | Restate Virtual Object (`AgentSession`) — durable, single invocation per conversation |
| Event streaming | Restate pubsub → SSE (`EventSource`) |
| Agent protocols | stdio (ACP over JSON-RPC) and A2A (HTTP) |
| Process management | `InProcessRuntimeHost` (holds agent stdio pipes) |
| API | [Hono](https://hono.dev/) on Node, port 3001 |
| Client | React 19, Vite, TanStack Router + Query, Tailwind v4 |

---

## Architecture

```
Frontend (React, port 3000)
  | HTTP + SSE
  v
Hono API Server (port 3001)
  | typed ingress client (@restatedev/restate-sdk-clients)
  v
Restate Runtime
  |- Ingress (port 18080) -- VO handler calls
  |- Admin   (port 19070) -- state queries
  '- Endpoint (port 9080) -- service registration
      |- AgentSession VO -- conversation loop, permissions, state
      '- pubsub VO ------- event distribution
  |
  v
InProcessRuntimeHost (holds agent processes)
  |- StdioAdapter -- local ACP agents (codex, claude, gemini, etc.)
  '- A2AAdapter --- HTTP agents (LangGraph, CrewAI, ADK)
  |
  v
Agent Processes (spawned via child_process or HTTP)
```

### How it works

1. `POST /api/sessions` resolves an agent template and calls `AgentSession.startSession()` via the Restate ingress client.
2. `startSession` spawns the agent process (via `InProcessRuntimeHost`), stores agent identity + connection metadata in VO state, and kicks off `conversationLoop` (fire-and-forget).
3. `conversationLoop` is a single Restate invocation that loops for the entire conversation:
   - Suspends on an awakeable (zero compute) waiting for the next prompt
   - Frontend sends `POST /api/sessions/:id/prompt` → `sendPrompt` resolves the awakeable
   - RuntimeHost drives the agent, streaming events to pubsub via external client
   - Agent finishes → publishes `complete` event → loop suspends again
4. Permissions: agent requests permission → handler creates an awakeable per request → publishes `permission_request` via SSE → user clicks Allow → `POST /api/sessions/:id/resume` resolves the awakeable directly → agent continues.
5. The React UI connects via `EventSource` to `/api/sessions/:id/events` for live streaming.

### Key patterns

- **Single invocation per conversation** — `conversationLoop` stays alive across turns. Zero compute between turns (Restate suspends on awakeables).
- **Ephemeral prompts, durable state** — agent responses stream via external pubsub (not journaled). Only deterministic values go through `ctx.set`.
- **Direct awakeable resolution** — permissions and prompts resolve awakeables via `ingress.resolveAwakeable()`, no shared handler needed.
- **`AgentRuntime` interface** — testable seam between VO handlers and Restate SDK (`step`, `sleep`, `now`, `emit`, `state`, `createDurablePromise`).

---

## Agent templates

Templates are configured in `apps/server/src/agent-templates.ts`:

```ts
{
  id: "codex",
  name: "Codex",
  spawn: { command: "npx", args: ["@zed-industries/codex-acp@0.10.0"] },
  runtime: { provider: "default" },
}
```

`POST /api/agent-templates` registers additional templates at runtime.

---

## HTTP API

Base URL: `http://localhost:3001/api`

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/agent-templates` | List agent templates |
| `POST` | `/agent-templates` | Register a template |
| `PUT` | `/agent-templates/:id` | Update a template |
| `GET` | `/sessions` | List all sessions (via Restate admin SQL) |
| `POST` | `/sessions` | Create a session (starts agent + conversation loop) |
| `GET` | `/sessions/:id` | Get session metadata |
| `POST` | `/sessions/:id/prompt` | Send a prompt (resolves awaiting-prompt awakeable) |
| `POST` | `/sessions/:id/resume` | Resolve a permission awakeable |
| `POST` | `/sessions/:id/cancel` | Cancel current prompt |
| `GET` | `/sessions/:id/events` | SSE event stream (text, tool, complete, permission_request) |
| `GET` | `/sessions/:id/fs` | Recursive directory listing |
| `GET` | `/sessions/:id/files?path=...` | Read file content |
| `POST` | `/sessions/:id/delegate` | Start a child agent session |

---

## Repository layout

```
apps/
  server/         # Node entry point — creates Flamecast, listens on 3001
  client/         # React UI — Vite, TanStack Router
  docs/           # Mintlify documentation site
packages/
  protocol/       # Shared TypeScript types (SessionEvent, SessionMeta, etc.)
  flamecast/      # @flamecast/sdk — the SDK
    src/
      flamecast-class.ts  # Flamecast class (template management + Hono app)
      api.ts              # Hono API routes (typed Restate ingress client)
      restate/            # AgentSession VO, shared-handlers, adapter types
      runtime/            # AgentRuntime interface + Restate/test implementations
      runtime-host/       # RuntimeHost, InProcessRuntimeHost, strategies
      adapters/           # StdioAdapter, A2AAdapter
      client/             # Browser SDK (FlamecastClient)
tests/
  echo-agent/     # Test ACP agent
```

---

## Configuration

```ts
import { Flamecast } from "@flamecast/sdk";

const flamecast = new Flamecast({
  agentTemplates: [...],
  restateUrl: "http://localhost:18080",
});

// Node.js
const server = flamecast.listen(3001, (info) => {
  console.log(`Running on ${info.port}`);
});

// Or mount on any runtime
export default flamecast.app;
```

| Option | Description |
|---|---|
| `agentTemplates` | Initial agent template list |
| `restateUrl` | Restate ingress URL (default: `http://localhost:18080`) |

---

## Environment variables

| Variable | Purpose |
|---|---|
| `RESTATE_INGRESS_URL` | Restate ingress endpoint (default: `http://localhost:18080`) |
| `FLAMECAST_RUNTIME_HOST` | `inprocess` (default) or `remote` — where agent processes run |
| `FLAMECAST_RUNTIME_HOST_URL` | RuntimeHost server URL (required when `remote`, e.g. `http://localhost:9100`) |
| `RUNTIME_HOST_PORT` | RuntimeHost server listen port (default: `9100`) |

---

## Related

- [Agent Client Protocol (ACP)](https://agentclientprotocol.com/)
- [Restate](https://restate.dev/)
- [A2A Protocol](https://github.com/google/A2A)
