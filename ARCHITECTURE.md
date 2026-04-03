# Flamecast Architecture

> Last updated: 2026-04-03. Source of truth for system design.
> For implementation tasks, see `bd show mono-b1s2`.

## What Flamecast Is

Flamecast is a **durable ACP gateway** — it sits between upstream consumers (browsers, APIs, other agents) and downstream ACP agents (Claude, Codex, Gemini, etc.), providing durable session management via Restate.

An upstream consumer talks to Flamecast using the same ACP protocol they'd use to talk to an agent directly. Flamecast handles the connection lifecycle, session persistence, and fault recovery transparently.

```
┌──────────────────┐         ┌────────────────────┐         ┌──────────────┐
│ Upstream Consumer │  ACP    │     Flamecast      │  ACP    │  Downstream  │
│ (browser, API,   │────────►│  (Restate VOs +    │────────►│  ACP Agents  │
│  another agent)  │◄────────│   durable sessions) │◄────────│  (claude,    │
│                  │         │                    │         │   codex...)  │
└──────────────────┘         └────────────────────┘         └──────────────┘
     FlamecastClient              AcpSession VO              ClientSideConnection
     implements Agent             Restate journal             over any Transport
```

## The ACP Protocol

We implement the [Agent Client Protocol](https://agentclientprotocol.com) (JetBrains ACP). Key concepts:

- **Agent** — the interface a client calls: `initialize`, `newSession`, `prompt`, `cancel`
- **Client** — the callback interface an agent calls: `sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile`
- **ClientSideConnection** — SDK class that implements `Agent` over a raw `Stream`
- **AgentSideConnection** — SDK class that implements `Client` callbacks over a raw `Stream`
- **Stream** — `{ readable: ReadableStream<AnyMessage>, writable: WritableStream<AnyMessage> }` — the bidirectional message channel

The protocol is JSON-RPC 2.0 over any transport that can produce a `Stream`.

Reference: https://agentclientprotocol.com/protocol/schema

## Package Structure

### `@flamecast/acp` (packages/acp) — Pure Protocol

Transport layer + agent registry. No Restate dependency. No process management.

```
src/
  transport.ts       — ByteConnection, Codec<T>, applyCodec(), ndJsonCodec(), jsonCodec()
  transports/
    stdio.ts         — connectStdio(opts) → ByteConnection (spawns child process)
    websocket.ts     — connectWs(opts) → ByteConnection (connects to WS server)
    http-sse.ts      — connectHttpSse(opts) → ByteConnection (POST + SSE)
  registry.ts        — loadRegistryFromIds(agentIds) → SpawnConfig[] (CDN agent lookup)
  acp-client.ts      — AcpClient class (lightweight multiplexing, used in tests)
```

**Transport model (simplified in latest refactor):**

```
ByteConnection          — raw byte streams (what stdio/ws/http give you)
  + Codec<T>            — ndJsonCodec(), jsonCodec() (swappable serialization)
  = acp.Stream          — what ClientSideConnection needs

// Example:
const bytes = await connectStdio({ cmd: "npx", args: ["claude-acp"] });
const stream = applyCodec(bytes, ndJsonCodec());
const conn = new ClientSideConnection((_agent) => client, stream);
```

### `@flamecast/sdk` (packages/flamecast) — Restate Orchestration

Restate VOs + the consumer-facing client.

```
src/
  session.ts         — AcpSession VO (newSession, prompt, cancel, getStatus, resumePermission, close)
                       configureAcp({ resolveAgent }), connections Map, reconnect()
  agents.ts          — AcpAgents stateless service (listAgents, getAgent)
  pubsub.ts          — pubsub VO for event streaming
  endpoint.ts        — Restate service registration + serve()
  client/
    index.ts         — FlamecastClient implements acp.Agent (consumer-facing)
  index.ts           — barrel exports
```

### `apps/server` — Entrypoint

Boots the Restate endpoint with agent configuration.

### `apps/client` — React Frontend

TanStack Router + React Query. Talks to Restate ingress via `FlamecastClient`.

## Architecture (implemented)

Direct `ClientSideConnection` from the ACP SDK. No pool, no factory, no resolver classes.

**Key insight: Restate's journal IS the session store.** Every agent gets `loadSession` capability for free because Restate durably stores the conversation history.

```
// Boot (apps/server)
const registry = await loadRegistryFromIds(agents);
function resolveAgent(name) → Promise<ByteConnection>  // just a function

configureAcp({ resolveAgent }, { ingressUrl });
serve(9080);

// Per session (inside VO handler — newSession)
const bytes = await resolveAgent(agentName);
const stream = applyCodec(bytes, ndJsonCodec());
const conn = new ClientSideConnection((_agent) => createCallbacks(ctx), stream);
await ctx.run("initialize", () => conn.initialize({ ... }));
await ctx.run("newSession", () => conn.newSession({ ... }));
// Store conn in module-level connections Map

// On prompt
const { conn } = await getOrReconnect(ctx);  // cache hit or reconnect
await conn.prompt({ ... });
// Journal turn in history[] for future replay

// On restart (connection lost)
reconnect():
  new connection → initialize → loadSession (or replay from journal history)
```

**Deleted:** pool.ts, factory.ts, resolver.ts
**Replaced by:** `resolveAgent()` function + `connections` Map + `getOrReconnect()` + `reconnect()`

## FlamecastClient — The Upstream Interface

`FlamecastClient` implements `acp.Agent`. From the consumer's perspective, it IS an ACP agent — same interface as `ClientSideConnection`, different transport.

```
// Direct agent (raw stream)
const conn = new ClientSideConnection((_agent) => myCallbacks, stream);
await conn.initialize({ ... });
await conn.newSession({ ... });
await conn.prompt({ ... });

// Through Flamecast (durable)
const conn = new FlamecastClient({ ingressUrl });
await conn.initialize({ ... });   // cached capabilities
await conn.newSession({ ... });    // → Restate ingress → AcpSession VO
await conn.prompt({ ... });        // → Restate ingress → AcpSession VO → downstream agent
```

Session updates arrive via pubsub SSE. Permission requests are resolved via Restate awakeables.

## Session Lifecycle

```
1. Consumer calls FlamecastClient.newSession({ cwd, mcpServers, _meta: { agentName } })
2. → Restate ingress → AcpSession VO newSession handler
3. Handler: resolveAgent(agentName) → ByteConnection → ClientSideConnection
4. Handler: conn.initialize() → conn.newSession() → store acpSessionId + conn in Map
5. Consumer calls FlamecastClient.prompt({ sessionId, prompt: [{ type: "text", text }] })
6. → Restate ingress → AcpSession VO prompt handler
7. Handler: get conn from Map → conn.prompt() → stream events via pubsub
8. If conn missing (restart): reconnect() → initialize → loadSession/replay → resume
```

## Key Design Decisions

1. **ACP spec first** — All types from `@agentclientprotocol/sdk`. No custom wrapper types. Use `_meta` for extensions.
2. **No wrapper classes** — Pass `acp.Client` and `ClientSideConnection` directly. Don't abstract the SDK.
3. **ByteConnection + Codec** — Transports return raw bytes. Codec is separate and swappable.
4. **Restate journal = session store** — `loadSession` for free. History stored in VO state.
5. **`resolveAgent()` is a function** — Not a factory class. Easy to test, easy to swap.
6. **FlamecastClient implements Agent** — Same interface as direct agent connection. Consumer doesn't know the difference.
7. **Delete immediately** — No backwards compat, no migration layers. Old code gets deleted.

## Open Questions

1. **Awakeable replay safety** — `prompt` is NOT wrapped in `ctx.run()` because its callbacks (sessionUpdate, requestPermission) fire during execution. If VO replays past a prompt with permissions, the awakeable ID emitted to the client is stale. Accepted: permission-requiring prompts aren't fully replay-safe. `reconnect()` re-establishes from journal history anyway.
2. **Process pooling for stdio** — Each session spawns a new process. May add a lightweight cache for same-agent connections as a future optimization, but not a core abstraction.

## References

- ACP Protocol: https://agentclientprotocol.com/protocol/schema
- ACP TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk
- Restate Durable Steps: https://docs.restate.dev/develop/ts/durable-steps
- Restate AI Patterns: https://docs.restate.dev/ai/patterns/tools
- Beads task: `bd show mono-b1s2` (P0 SDD with migration checklist)
