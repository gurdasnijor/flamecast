# Flamecast

Flamecast is an open-source, self-hostable control plane for [ACP](https://agentclientprotocol.com/)-compatible agents. It manages durable agent sessions via [Restate](https://restate.dev/) Virtual Objects, brokers permission requests through awakeables, streams events via pubsub, and ships a React UI.

---

## Quick start

```bash
pnpm install
pnpm dev
```

Open **http://localhost:3000**. Select an agent and click **Start session**.

---

## Stack

| Layer | Technology |
|---|---|
| Session orchestration | Restate Virtual Object (`AcpSession`) — exclusive handlers per turn, shared handlers for queries |
| Agent transport | `@flamecast/acp` — pluggable transports (stdio, WebSocket, HTTP+SSE, Protobuf, NATS) |
| Agent process pool | `PooledConnectionFactory` — one process per agent name, mutable client delegation |
| Event streaming | Restate pubsub → SSE via `@restatedev/pubsub-client` |
| Agent protocol | [Agent Client Protocol](https://agentclientprotocol.com/) (JSON-RPC over stdio/WS/HTTP) |
| Agent discovery | `AcpAgents` Restate service + ACP CDN registry |
| Control plane API | Restate ingress (auto-generated OpenAPI 3.1 from Zod schemas) |
| Client SDK | `@flamecast/sdk/client` — typed Restate SDK client (browser-safe) |
| Frontend | React 19, Vite, TanStack Router + Query, Tailwind v4 |

---

## Architecture

```
Frontend (React, port 3000)
  | Vite proxy /restate/* → Restate ingress
  v
Restate Runtime
  |- Ingress (port 18080) — handler calls (auto-generated REST API)
  |- Admin   (port 19070) — state queries, OpenAPI specs
  '- Endpoint (port 9080) — service registration
      |- AcpSession VO — newSession, prompt, cancel, resumePermission, getStatus, close
      |- AcpAgents svc — listAgents, getAgent (CDN registry)
      '- pubsub VO ---- event distribution
  |
  v
PooledConnectionFactory (agent process table)
  |- RegistryConnectionFactory — resolves agent name → transport
  |    |- StdioTransport  — local agents (codex, claude, gemini, etc.)
  |    |- WsTransport     — remote agents via WebSocket
  |    '- HttpSseTransport — remote agents via HTTP+SSE
  v
Agent Processes (ACP protocol — initialize, session/new, session/prompt)
```

### How it works

1. `POST /AcpSession/{key}/newSession` resolves the agent via `AgentConnectionFactory`, connects via the appropriate transport, does the ACP handshake (initialize + session/new), and returns `{ sessionId }`.

2. `POST /AcpSession/{key}/prompt` is an exclusive, blocking handler. It sends the prompt to the agent via `conn.prompt()`, streams `session/update` notifications to pubsub during processing, suspends on awakeables for permission requests, and returns `{ stopReason }` when the turn completes.

3. Permission flow: agent calls `session/request_permission` → `FlamecastClient.requestPermission()` creates a Restate awakeable → emits `permission_request` event to pubsub → frontend/caller resolves via `POST /AcpSession/{key}/resumePermission` → agent continues.

4. The `PooledConnectionFactory` maintains one agent process per agent name. Multiple sessions share the same process. A delegating `acp.Client` swaps the active callback reference per handler invocation so each Restate context gets its own pubsub/awakeable routing.

### Key patterns

- **Spec-aligned handlers** — `newSession`, `prompt`, `cancel` map directly to ACP protocol methods.
- **Exclusive prompt, shared queries** — `prompt` is exclusive (serial per key), `getStatus`/`cancel`/`resumePermission` are shared (concurrent).
- **`acp.Client` interface** — `FlamecastClient` implements the ACP client callback interface (session updates → pubsub, permissions → awakeables, filesystem → node:fs).
- **Process pool with mutable delegation** — one `ClientSideConnection` per agent, callback routing swapped per handler invocation.
- **Zod schemas from `@agentclientprotocol/sdk`** — handler I/O types composed from SDK schemas, auto-generates OpenAPI 3.1.
- **No hand-rolled types** — `SessionState = acp.SessionInfo`, agent identity via `_meta.agentName` (ACP extensibility).

---

## Packages

```
packages/
  acp/            @flamecast/acp — transport layer + connection factory
    src/
      acp-client.ts      — AgentConnectionFactory interface
      transport.ts        — Transport<T> + TransportConnection
      resolver.ts         — RegistryConnectionFactory (CDN registry → transport)
      pool.ts             — PooledConnectionFactory (process table)
      registry.ts         — CDN agent registry resolution
      transports/
        stdio.ts          — StdioTransport
        websocket.ts      — WsTransport
        http-sse.ts       — HttpSseTransport
        protobuf.ts       — ProtobufTransport (binary WS)
        nats.ts           — NatsTransport
    test/
      transport.test.ts   — 8 in-memory protocol tests
      acp-client.test.ts  — connection factory tests
      pool.test.ts        — process pool + mutable delegation tests
      http-sse-transport.test.ts
      ws-transport.test.ts
      protobuf-transport.test.ts
      nats-transport.test.ts
      gateway.test.ts     — gateway pattern across transports
      transport-bench.test.ts

  flamecast/      @flamecast/sdk — Restate services + client
    src/
      session.ts          — AcpSession VO (inline handlers)
      agents.ts           — AcpAgents stateless service
      pubsub.ts           — pubsub VO
      endpoint.ts         — service registration + serve()
      client/index.ts     — FlamecastClient (browser-safe, ./client export)
      index.ts            — barrel exports

  protocol/       @flamecast/protocol — shared TypeScript types
  client/         (deleted — merged into @flamecast/sdk/client)

apps/
  client/         React UI — Vite, TanStack Router
  server/         (legacy — Restate is the server now)
```

---

## Configuration

| Variable | Purpose |
|---|---|
| `ACP_AGENTS` | Comma-separated agent IDs from the ACP CDN registry (default: `claude-acp`) |
| `RESTATE_INGRESS_URL` | Restate ingress endpoint (default: `http://localhost:18080`) |
| `VITE_RESTATE_INGRESS_URL` | Frontend ingress URL (default: `/restate` via Vite proxy) |

---

## OpenAPI

Restate auto-generates OpenAPI 3.1 specs from the Zod-typed handler schemas:

```bash
curl http://localhost:19070/services/AcpSession/openapi
curl http://localhost:19070/services/AcpAgents/openapi
```

---

## Related

- [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) — the protocol we implement
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) — `ClientSideConnection`, `AgentSideConnection`
- [Restate](https://restate.dev/) — durable execution runtime
- [ACP CDN Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) — agent discovery
