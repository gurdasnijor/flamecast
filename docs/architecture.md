# Flamecast Architecture (Restate-based)

Durable agent orchestration platform. Bridges ACP (Agent Client Protocol) agents with Restate's durable execution engine. Supports Zed (stdio JSON-RPC) and IBM (HTTP REST) agent protocols.

## System Topology

```
Frontend (React, port 3000)
  │ HTTP + SSE
  ▼
Hono API Server (port 3001)
  │ JSON-RPC over HTTP
  ▼
Restate Runtime
  ├─ Ingress (port 18080) ── service calls
  ├─ Admin   (port 19070) ── state queries
  └─ Endpoint (port 9080) ── VO registration
      ├─ ZedAgentSession VO ── stdio ACP agents
      ├─ IbmAgentSession VO ── HTTP REST ACP agents
      └─ pubsub VO ────────── event distribution
  │
  ▼
Agent Adapters
  ├─ ZedAcpAdapter ── spawns local process, stdio JSON-RPC
  ├─ IbmAcpAdapter ── calls IBM ACP REST API
  └─ HttpJsonRpcBridge ── HTTP transport for containerized Zed agents
  │
  ▼
Agent Processes (Claude, Codex, Gemini, Copilot, Kilo Code, Cline)
```

## Ports

| Service | Port | Purpose |
|---------|------|---------|
| Restate Ingress | 18080 | VO handler invocation |
| Restate Admin | 19070 | SQL state queries |
| Restate Endpoint | 9080 | Service registration |
| Hono API | 3001 | Frontend-facing HTTP API |
| Go Session-Host | dynamic | Agent process management (spawned by NodeRuntime) |

---

## Control Plane: Restate Virtual Objects

### Registered Services (`endpoint.ts`)

```typescript
services = [pubsubObject, IbmAgentSession, ZedAgentSession]
```

### VO State Keys (per session)

| Key | Type | Description |
|-----|------|-------------|
| `session` | SessionHandle | Agent process info, protocol, connection |
| `meta` | SessionMeta | Status, timestamps, agent info |
| `cwd` | string | Working directory |
| `generation` | number | Stale-resume guard counter |
| `pending_pause` | object | Awakeable info when agent awaits input |
| `pending_run` | object | IBM only: awakeable for run completion |
| `lastRun` | PromptResult | Most recent prompt result |

### Shared Handlers (both VOs)

| Handler | Type | What it does |
|---------|------|-------------|
| `resumeAgent` | shared | Resolve awakeable (generation-guarded) |
| `getStatus` | shared | Return meta + cwd |
| `getWebhooks` | shared | Return webhook configs |
| `cleanup` | exclusive | Clear all state (TTL garbage collection) |

### ZedAgentSession Handlers

| Handler | Pattern | Description |
|---------|---------|-------------|
| `startSession` | `ctx.run("start")` | Spawn agent, store handle + meta |
| `runAgent` | ephemeral prompt + durable awakeables | See below |
| `steerAgent` | cancel + reconfig + re-prompt | Each step in separate `ctx.run()` |
| `cancelAgent` | `ctx.run("cancel")` | Kill prompt, clear pending state |
| `terminateSession` | `ctx.run("close")` | Kill process, schedule 7-day cleanup |

### IbmAgentSession Handlers

| Handler | Pattern | Description |
|---------|---------|-------------|
| `startSession` | `ctx.run("start")` | Verify agent exists via REST |
| `runAgent` | create + awakeable (zero compute) | See below |
| `steerAgent` | cancel + create-run + awakeable | Same two-phase pattern |
| `cancelAgent` | `ctx.run("cancel")` | Clear pending_pause + pending_run |
| `terminateSession` | same as Zed | Close adapter, schedule cleanup |

---

## Core Patterns

### Pattern 1: Ephemeral Prompt + Durable Awakeables (Zed)

`promptSync()` runs **outside** `ctx.run()` so callbacks can access Restate context.

```
runAgent handler:
  1. ctx.get("session")                         ← journaled
  2. adapter.setPermissionHandler(handler)       ← injects callback
  3. adapter.setPublishSink(sink)                ← injects callback
  4. await adapter.promptSync(session, text)     ← NOT journaled (ephemeral)
     │
     ├─ Agent works, streams text/tool events
     │   └─ publishSink → publish(ctx, topic, event) → pubsub → SSE
     │
     ├─ Agent hits permission check
     │   └─ permissionHandler fires:
     │       ├─ ctx.awakeable() ← journaled
     │       ├─ publish permission_request event
     │       ├─ await promise   ← VO SUSPENDS (zero compute)
     │       ├─ [user clicks approve → POST /resume → resolveAwakeable]
     │       └─ return { outcome: "selected", optionId }
     │
     └─ Returns PromptResult
  5. handleResult(ctx, result)                   ← journals final result
```

**Trade-off**: If VO crashes mid-prompt, the prompt re-runs (agent process may be gone). Awakeables and state mutations are durable. The prompt itself is ephemeral.

### Pattern 2: Create + Awakeable (IBM)

Two-phase: journal the runId immediately, then suspend at zero cost.

```
runAgent handler:
  Phase 1: ctx.run("create-run")               ← journaled, returns runId
           publish("run.started", { runId })
  Phase 2: ctx.awakeable()                      ← journaled
           ctx.set("pending_run", { awakeableId, runId })
           await promise                         ← VO SUSPENDS (zero compute)

  [Meanwhile, API layer runs watchAgentRun()]:
    ├─ GET agent SSE stream at /runs/{runId}/events
    ├─ Forward message.part tokens → pubsub → SSE → client
    └─ On terminal state → resolveAwakeable(result)
         └─ VO resumes → handleResult()
```

### Pattern 3: Generation Counter (Stale Resume Guard)

```
Permission/pause cycle:
  1. generation = (ctx.get("generation") ?? 0) + 1
  2. ctx.set("generation", generation)
  3. publish event with generation
  4. ctx.awakeable() → store with generation
  5. await promise

Resume:
  1. Client sends { awakeableId, generation, payload }
  2. resumeAgent checks: pending_pause.generation === input.generation
  3. If mismatch → TerminalError("Stale resume")
  4. If match → resolveAwakeable(payload)
```

Prevents stale resumes after cancel/steer operations.

---

## Data Plane: Event Streaming

### Publish Path

```
VO handler
  → publish(ctx, "session:{id}", event)
    → ctx.objectSendClient({ name: "pubsub" }, topic).publish(event)
      → pubsub VO stores event with offset
```

### Subscribe Path (SSE)

```
GET /api/sessions/:id/events
  → createPubsubClient({ ingressUrl }).sse({ topic: "session:{id}" })
    → ReadableStream<Uint8Array> piped as text/event-stream Response
      → EventSource in browser parses SSE frames
        → useFlamecastSession hook appends to events[]
          → logs-markdown.ts renders segments
```

### SessionEvent Wire Schema (flat, top-level type)

```typescript
// Lifecycle
{ type: "session.created", meta: SessionMeta }
{ type: "session.terminated" }
{ type: "run.started", runId: string }

// Completion
{ type: "complete", result: { status, output?, runId?, error? } }

// Pause/resume
{ type: "pause", request: unknown, generation: number }

// Permissions
{ type: "permission_request", requestId, toolCallId, title, kind?,
  options: [{ optionId, name, kind }], awakeableId, generation }

// Real-time streaming (during prompt execution)
{ type: "text", text: string, role: "assistant" | "thinking" }
{ type: "tool", toolCallId, title, status, input?, output? }
```

---

## External API (Hono Routes)

### Templates & Runtimes (in-memory)

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/agent-templates` | - | AgentTemplate[] |
| POST | `/api/agent-templates` | RegisterAgentTemplateBody | AgentTemplate |
| PUT | `/api/agent-templates/:id` | UpdateAgentTemplateBody | AgentTemplate |
| GET | `/api/runtimes` | - | RuntimeInfo[] |
| POST | `/api/runtimes/:type/start` | { name? } | RuntimeInstance |
| POST | `/api/runtimes/:name/stop` | - | { ok: true } |

### Sessions (delegates to Restate VOs)

| Method | Path | Body | Restate Target | Response |
|--------|------|------|----------------|----------|
| GET | `/api/sessions` | - | Admin SQL query | SessionMeta[] |
| POST | `/api/sessions` | { agentTemplateId, cwd? } | `startSession` | { id, ...SessionHandle } |
| GET | `/api/sessions/:id` | - | `getStatus` | { id, ...SessionMeta } |
| POST | `/api/sessions/:id/prompt` | { text } | `runAgent` | PromptResult |
| POST | `/api/sessions/:id/resume` | { awakeableId, payload, generation } | `resumeAgent` | { ok: true } |
| POST | `/api/sessions/:id/cancel` | {} | `cancelAgent` | { cancelled: true } |

### Filesystem (reads from session cwd)

| Method | Path | Query | Response |
|--------|------|-------|----------|
| GET | `/api/sessions/:id/fs` | - | { root, entries: [{ path, type }] } |
| GET | `/api/sessions/:id/files` | `?path=relative/path` | { path, content } |

### Events (SSE)

| Method | Path | Headers | Response |
|--------|------|---------|----------|
| GET | `/api/sessions/:id/events` | `Last-Event-ID` (optional) | `text/event-stream` |

### Session Listing: Admin SQL Query

```sql
SELECT service_key, value FROM state
WHERE service_name = 'ZedAgentSession' AND key = 'meta'
-- UNION with IbmAgentSession
-- Values are hex-encoded JSON: Buffer.from(hex, 'hex').toString('utf8')
```

---

## ACP Adapters

### Why Two Adapters?

Zed ACP and IBM ACP are different wire protocols:

| | Zed ACP | IBM ACP |
|---|---------|---------|
| Transport | stdio (JSON-RPC over stdin/stdout) | HTTP REST |
| Connection | Long-lived process with pipes | Stateless HTTP calls |
| Streaming | `sessionUpdate` notifications via SDK callback | SSE stream at `/runs/{id}/events` |
| Permission | `requestPermission` SDK callback (sync) | N/A (handled differently) |
| Run model | Single blocking `prompt()` call | `runAsync()` → poll/SSE → terminal |
| Cancellation | `connection.cancel()` via JSON-RPC | No-op (stateless) |

### ZedAcpAdapter (`zed-acp-adapter.ts`)

**FlamecastClient** (implements `acp.Client`):
- Receives ACP callbacks: `sessionUpdate()`, `requestPermission()`
- Has injectable sinks: `publishSink` (→ pubsub), `permissionHandler` (→ awakeables)
- Collects text during `promptSync()` for final PromptResult output
- Supports both stdio (`sdkConnections` Map) and HTTP bridge (`httpConnections` Map)

**Connection lifecycle**:
```
start() → spawn process / connect HTTP → ACP initialize → session/new → SessionHandle
promptSync() → connection.prompt() → collect text + handle callbacks → PromptResult
cancel() → connection.cancel()
close() → kill process
```

### IbmAcpAdapter (`ibm-acp-adapter.ts`)

**Stateless HTTP calls**:
```
start() → verify agent at URL → SessionHandle
createRun() → client.runAsync() → { runId }
promptSync() → client.runSync() → PromptResult
resumeSync() → client.runResumeSync() → PromptResult
cancel() → no-op
close() → no-op
```

### HttpJsonRpcBridge (`http-bridge.ts`)

For containerized Zed agents that can't use stdio directly:

```
BridgeServer (runs alongside agent in container):
  POST /jsonrpc  → write to agent stdin
  GET /events    → SSE of agent stdout (parsed JSON-RPC)

HttpJsonRpcConnection (client in adapter):
  request(method, params) → POST /jsonrpc → await response via SSE
  notify(method, params) → POST /jsonrpc (fire and forget)
  onRequest(handler) → bidirectional: agent → handler → response back
```

---

## Storage

**No database.** All session state lives in Restate VO state (distributed key-value, partitioned by session ID).

| What | Where | How |
|------|-------|-----|
| Session metadata | VO state (`meta` key) | `ctx.get/set` |
| Agent connection info | VO state (`session` key) | `ctx.get/set` |
| Permission state | VO state (`pending_pause` key) | `ctx.get/set/clear` |
| Agent templates | In-memory (Flamecast class) | Passed at init, mutable via API |
| Runtime instances | In-memory (Runtime classes) | Managed by NodeRuntime/Docker/E2B |
| Session listing | Restate Admin SQL API | `POST :19070/query` with SQL |

---

## Permission Request Flow (End-to-End)

```
1. Agent runs tool, needs permission
   └─ ACP SDK calls FlamecastClient.requestPermission(params)

2. permissionHandler (injected by VO) fires:
   ├─ Increment generation counter
   ├─ Create awakeable → { id: "sign_...", promise }
   ├─ Store pending_pause state
   └─ Publish to pubsub:
       { type: "permission_request", requestId, toolCallId, title,
         kind, options, awakeableId, generation }

3. VO SUSPENDS on awakeable promise (zero compute)

4. SSE delivers event to browser EventSource
   └─ Frontend renders permission dialog (buttons from options[])

5. User clicks "Yes" (optionId: "approved")
   └─ POST /api/sessions/:id/resume
       { awakeableId: "sign_...", payload: { optionId: "approved" }, generation: 1 }

6. Hono route proxies to Restate:
   └─ POST :18080/ZedAgentSession/:id/resumeAgent

7. resumeAgent (shared handler):
   ├─ Check pending_pause.generation === input.generation
   └─ ctx.resolveAwakeable(awakeableId, payload)

8. VO resumes:
   ├─ requestPermission() returns { outcome: "selected", optionId: "approved" }
   └─ Agent continues execution

9. Frontend injects local permission_responded event → dialog dismissed
```

---

## Known Architectural Debt

### Ad-hoc Callback Injection (mono-x2xz, P1)

Currently injects individual callbacks per capability:
```typescript
adapter.setPermissionHandler(session, handler);
adapter.setPublishSink(session, sink);
```

Should be a single `SessionRuntime` interface (Forge pattern):
```typescript
const runtime = createSessionRuntime(ctx);
adapter.promptSync(session, text, runtime);
// Inside: runtime.emit(event), runtime.awakeable(), runtime.state.get/set
```

Reference: `~/smithery/forge/packages/runtime/src/restate.ts`

### Ephemeral Prompt on Replay

If the VO crashes mid-prompt, `promptSync()` re-executes but the agent process may be gone. Accepted trade-off: awakeables are durable, the prompt is ephemeral. Agent crash = user retries.

### Go Session-Host Still Required

The Go binary (`@flamecast/session-host-go`) still manages agent process spawning for NodeRuntime. The VO can't hold process pipes across suspension. Long-term: container runtimes (Docker/E2B) don't need local process management.
