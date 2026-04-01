# Flamecast — Architecture Redesign

You are rebuilding Flamecast from its current working state. Read this entire
document before writing any code. The changes are coordinated.

---

## What Flamecast Is

Flamecast is a **durable agent orchestration broker**. It does not own agent
tool loops. Agents are black boxes: Flamecast spawns them, sends prompts,
receives streamed output, brokers permission requests, and terminates them.

Current stack:
- **Frontend** — React, port 3000, consumes SSE via EventSource
- **Hono API** — port 3001
- **Restate** — ingress 18080, admin 19070, endpoint 9080
- **Registered VOs** — `ZedAgentSession`, `IbmAgentSession`, `pubsub`
- **Go session-host** — manages stdio agent process lifecycles (to be replaced)

The new stack registers: `AgentSession`, `pubsub` (updated). That's it.

---

## Scope of Changes

These are the six coordinated changes:

1. **`AgentRuntime` interface** — testable seam between VO handlers and Restate
2. **Unified `AgentSession` VO** — one VO, protocol-selected adapter
3. **TypeScript `RuntimeHost`** — replaces Go binary, local-first, no HTTP overhead
4. **`A2AAdapter`** — canonical HTTP adapter replacing `IbmAcpAdapter`
5. **SSE replay correctness** — offset-based pubsub replay
6. **Agent-to-agent communication** — using the VO topology directly

**Not changing:**
- `SessionEvent` wire schema — frontend depends on it. One addition:
  `{ type: 'permission_responded'; awakeableId: string; decision: unknown }`
  emitted by `resumeAgent` so RuntimeHost can unblock its SDK callback via SSE.
- Hono session route shapes — frontend depends on them
- The two-phase HTTP pattern (journal runId → suspend on awakeable)
- The `handleAwaiting` generation counter loop — it is correct, preserve exactly
- `pubsub` VO name

**Not building:**
- `PermissionBroker` as a separate Workflow — permissions stay on the session VO
  via `handleAwaiting`. A separate Workflow adds a network hop with no benefit
  unless you need cross-session permission querying, which you don't.
- `AgentRegistry` as a Restate VO — manifests are config, not workflow state.
  They don't need journal replay semantics. Keep them in whatever config layer
  you're already using (in-memory map, JSON file, or a database table). Restate
  VO state is for things that must survive mid-execution crashes. Agent manifests
  don't qualify.

---

## What to Read First

Before writing any code, read these files in the current codebase:

- `shared-handlers.ts` — `publish()`, `handleResult()`, `handleAwaiting()`,
  `sharedHandlers`. The `handleAwaiting` loop with generation counter is the
  core correctness mechanism. Preserve it exactly.
- `adapter.ts` — `AgentAdapter` interface, `SessionHandle`, `PromptResult`,
  `SessionMeta` types. These shapes are correct.
- `ibm-acp-vo.ts` — the two-phase `runAgent` pattern: `ctx.run("create-run")`
  journals runId, then `ctx.awakeable()` suspends at zero cost. This is the
  model for all HTTP agents.
- `ibm-acp-adapter.ts` — `mapStreamEvent()`, `runToOutput()`, `toInput()`.
  The A2A adapter needs equivalent helpers.

---

## Change 1: `AgentRuntime` Interface

### Why

VO handlers currently inject Restate context directly into adapters via
callbacks (`setPermissionHandler`, `setPublishSink`). There is no testable
seam. The two VOs duplicate handler shapes. `AgentRuntime` makes the seam
explicit.

**Important constraint:** This is not a port of the Forge `AgentRuntime`.
Forge owns the tool loop; Flamecast does not. This interface is narrower —
it provides durable primitives to VO handlers only.

### Interface

```typescript
// packages/runtime/src/types.ts
// NO Restate imports in this file. Must be implementable without the SDK.

import type { SessionEvent } from '@flamecast/protocol/session'

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface DurablePromise<T> {
  /** Stable ID used to resolve this promise from outside the VO. */
  id: string
  /** Awaiting this suspends the VO at zero compute cost. */
  promise: Promise<T>
}

export interface AgentRuntime {
  /** Session ID — the VO key. */
  readonly key: string
  readonly log: Logger

  // ── Durable execution ────────────────────────────────────────────────────

  /**
   * Journal a side-effecting operation.
   * On Restate replay, fn() is skipped and the journaled result returned.
   * Maps to ctx.run(name, fn).
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>

  /**
   * Durable sleep. VO suspends, zero compute consumed.
   * Maps to ctx.sleep(ms).
   */
  sleep(durationMs: number): Promise<void>

  /**
   * Deterministic current timestamp.
   * Journaled — returns the same value on replay, never live wall clock.
   * Maps to ctx.date.toJSON().
   */
  now(): Promise<string>

  // ── Durable promises ────────────────────────────────────────────────────

  /**
   * Create a durable promise that will be resolved by an external caller.
   *
   * Call pattern (must follow this ordering):
   *   1. const gen = ((await runtime.state.get('generation')) ?? 0) + 1
   *   2. runtime.state.set('generation', gen)
   *   3. const dp = runtime.createDurablePromise<T>(tag, gen)
   *      // createDurablePromise must be called synchronously here —
   *      // Restate does not journal awakeables created inside ctx.run().
   *   4. runtime.emit({ type: 'pause', awakeableId: dp.id, generation: gen, ... })
   *   5. const result = await dp.promise   // VO suspends here, zero compute
   *
   * The emitted event carries dp.id so the UI knows how to resolve it via
   * POST /api/sessions/:id/resume { awakeableId: dp.id, generation, payload }.
   *
   * Maps to ctx.awakeable() — the `id` is the awakeable ID.
   */
  createDurablePromise<T>(tag: string, generation: number): DurablePromise<T>

  /**
   * Resolve a pending durable promise. Validates generation to reject stale
   * resumes after cancel/steer. Throws on mismatch.
   * Called by the resumeAgent shared handler.
   * Maps to ctx.resolveAwakeable() with generation check.
   */
  resolveDurablePromise(id: string, generation: number, payload: unknown): void

  // ── State ────────────────────────────────────────────────────────────────

  /**
   * KV state scoped to this session VO.
   * set/clear are synchronous (ctx.set/ctx.clear — journal entry, immediate).
   * get is async (ctx.get — reads from Restate state storage).
   */
  state: {
    get<T>(key: string): Promise<T | null>
    set(key: string, value: unknown): void
    clear(key: string): void
    clearAll(): void
  }

  // ── Events ───────────────────────────────────────────────────────────────

  /**
   * Publish a SessionEvent to this session's pubsub topic.
   * Fire-and-forget (objectSendClient). Runtime fills timestamp if omitted.
   * Maps to the existing publish() helper.
   */
  emit(event: Omit<SessionEvent, 'timestamp'> & { timestamp?: string }): void

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Schedule cleanup of this session's VO state after a delay.
   * Maps to objectSendClient(AgentSession, key, { delay }).cleanup().
   */
  scheduleCleanup(delayMs: number): void
}
```

### Restate Implementation

```typescript
// packages/runtime/src/restate.ts

import * as restate from '@restatedev/restate-sdk'
import type { AgentRuntime, DurablePromise } from './types.js'

export interface RestateRuntimeOptions {
  pubsubName: string    // 'pubsub'
  objectName: string    // 'AgentSession'
}

export function createRestateRuntime(
  ctx: restate.ObjectContext,
  options: RestateRuntimeOptions,
): AgentRuntime {
  return {
    key: ctx.key,
    log: {
      info:  (...a) => ctx.console.info(...a),
      warn:  (...a) => ctx.console.warn(...a),
      error: (...a) => ctx.console.error(...a),
    },

    step:  (name, fn) => ctx.run(name, fn),
    sleep: (ms)       => ctx.sleep(ms),
    now:   ()         => ctx.date.toJSON() as unknown as Promise<string>,

    // IMPORTANT: ctx.awakeable() must be called synchronously in the handler
    // body — not inside ctx.run() or a .then(). The caller has already
    // incremented generation and called ctx.set('generation', gen) before
    // calling this method. See call pattern in the interface doc above.
    createDurablePromise<T>(tag: string, generation: number): DurablePromise<T> {
      const { id, promise } = ctx.awakeable<T>()
      ctx.set('pending_pause', { id, generation, tag })
      return { id, promise }
    },

    resolveDurablePromise(id, generation, payload) {
      // This runs inside the resumeAgent shared handler (ObjectSharedContext).
      // The shared handler reads pending_pause and validates generation before
      // calling ctx.resolveAwakeable. See sharedHandlers.resumeAgent.
      // This method is here for test runtime symmetry; the Restate impl
      // delegates to the shared handler pattern in the VO.
      ctx.get<{ id: string; generation: number }>('pending_pause').then((pending) => {
        if (!pending || pending.generation !== generation) {
          throw new restate.TerminalError('Stale resume — generation mismatch', { errorCode: 409 })
        }
        ctx.resolveAwakeable(id, payload)
      })
    },

    state: {
      get:      (k)    => ctx.get(k),
      set:      (k, v) => ctx.set(k, v),
      clear:    (k)    => ctx.clear(k),
      clearAll: ()     => ctx.clearAll(),
    },

    emit(event) {
      const e = { timestamp: new Date().toISOString(), ...event }
      const client = ctx.objectSendClient<{ publish: (m: unknown) => void }>(
        { name: options.pubsubName }, ctx.key,
      )
      ;(client as unknown as { publish: (m: unknown) => void }).publish(e)
    },

    scheduleCleanup(delayMs) {
      ctx.objectSendClient({ name: options.objectName }, ctx.key, { delay: delayMs })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .cleanup()
    },
  }
}
```

### Test Implementation

```typescript
// packages/runtime/src/test.ts
// Zero Restate dependency. For unit tests.

import type { AgentRuntime, DurablePromise } from './types.js'
import type { SessionEvent } from '@flamecast/protocol/session'

export function createTestRuntime(sessionId = 'test-session'): AgentRuntime & {
  /** Resolve a pending durable promise directly by ID (no generation check). */
  resolveDurablePromiseById(id: string, payload: unknown): void
  /** All events emitted during this run. */
  events: SessionEvent[]
  /** Raw state map for assertions. */
  stateMap: Map<string, unknown>
} {
  const stateMap  = new Map<string, unknown>()
  const resolvers = new Map<string, (v: unknown) => void>()
  const events: SessionEvent[] = []

  return {
    key: sessionId,
    log: { info: console.info, warn: console.warn, error: console.error },

    step:  (_n, fn) => fn(),
    sleep: ()       => Promise.resolve(),
    now:   ()       => Promise.resolve(new Date().toISOString()),

    createDurablePromise<T>(tag: string, generation: number): DurablePromise<T> {
      let resolve!: (v: T) => void
      const promise = new Promise<T>((res) => { resolve = res })
      const id = `dp-${tag}-gen${generation}`
      resolvers.set(id, resolve as (v: unknown) => void)
      stateMap.set('pending_pause', { id, generation, tag })
      return { id, promise }
    },

    resolveDurablePromise(id, generation, payload) {
      const pending = stateMap.get('pending_pause') as { generation: number } | null
      if (!pending || pending.generation !== generation) {
        throw new Error('Stale resume — generation mismatch')
      }
      resolvers.get(id)?.(payload)
    },

    resolveDurablePromiseById(id, payload) {
      resolvers.get(id)?.(payload)
    },

    state: {
      get:      (k)    => Promise.resolve((stateMap.get(k) ?? null) as any),
      set:      (k, v) => { stateMap.set(k, v) },
      clear:    (k)    => { stateMap.delete(k) },
      clearAll: ()     => { stateMap.clear() },
    },

    emit: (event) => {
      events.push({ timestamp: new Date().toISOString(), ...event } as SessionEvent)
    },

    scheduleCleanup: () => { /* no-op */ },
    events,
    stateMap,
  }
}
```

---

## Change 2: Update `shared-handlers.ts`

Add `runtime: AgentRuntime` to `handleResult` and `handleAwaiting`. Replace raw
`ctx.awakeable()` + manual generation bookkeeping with `runtime.createDurablePromise`.
Replace `publish()` calls with `runtime.emit()`.

Keep the `resumeAgent` shared handler reading directly from `ctx` — it runs in
an `ObjectSharedContext` and does not have access to the runtime, which requires
`ObjectContext`. The shared handler validates generation from state itself:

```typescript
// shared-handlers.ts — updated signatures

export async function handleResult(
  ctx: restate.ObjectContext,
  runtime: AgentRuntime,      // ← added
  adapter: AgentAdapter,
  session: SessionHandle,
  result: PromptResult,
): Promise<PromptResult>

export async function handleAwaiting(
  ctx: restate.ObjectContext,
  runtime: AgentRuntime,      // ← added
  adapter: AgentAdapter,
  session: SessionHandle,
  result: PromptResult,
): Promise<PromptResult> {
  let current = result

  while (current.status === 'awaiting') {
    // 1. Read and increment generation BEFORE creating durable promise.
    //    createDurablePromise() calls ctx.awakeable() which must be synchronous.
    const gen = ((await ctx.get<number>('generation')) ?? 0) + 1
    ctx.set('generation', gen)

    // 2. Create durable promise synchronously (stores pending_pause state).
    const dp = runtime.createDurablePromise<unknown>('pause', gen)

    // 3. Emit pause event with the promise ID so UI can call /resume.
    runtime.emit({
      type: 'pause',
      request: current.awaitRequest,
      generation: gen,
      awakeableId: dp.id,
    })

    // 4. Suspend — zero compute until client POSTs /resume.
    const resumePayload = await dp.promise

    ctx.clear('pending_pause')

    // 5. Capture runId before ctx.run to avoid closure over mutable variable.
    const runId = current.runId!
    current = await ctx.run('resume', () =>
      adapter.resumeSync!(session, runId, resumePayload),
    )
  }

  ctx.set('lastRun', current)
  runtime.emit({ type: 'complete', result: current })
  return current
}

// sharedHandlers.resumeAgent — emits permission_responded so RuntimeHost can unblock
// pending_pause stays as the state key (already correct in existing code)
resumeAgent: restate.handlers.object.shared(
  { enableLazyState: true },
  async (ctx, input: { awakeableId: string; payload: unknown; generation: number }) => {
    const pending = await ctx.get<{ generation: number }>('pending_pause')
    if (!pending || pending.generation !== input.generation) {
      throw new restate.TerminalError('Stale resume — pause was cancelled or superseded')
    }
    ctx.resolveAwakeable(input.awakeableId, input.payload)

    // Emit so RuntimeHost (listening on SSE) can unblock its SDK callback
    ctx.objectSendClient<{ publish: (m: unknown) => void }>(
      { name: 'pubsub' }, `session:${ctx.key}`,
    ).publish({
      type: 'permission_responded',
      awakeableId: input.awakeableId,
      decision: input.payload,
    })
  },
),
```

---

## Change 3: TypeScript `RuntimeHost`

### Why and What

The Go binary exists because Restate VOs cannot hold stdio pipes across
suspension. Replace it with a TypeScript module that owns process lifecycles.

**Key design decision: local-first, no HTTP overhead.**

For local development and in-process prototyping, spawning a separate HTTP
sidecar is wasteful. The RuntimeHost is an **interface**, not a server:

```typescript
// packages/runtime-host/src/types.ts

export interface AgentSpec {
  strategy: 'local' | 'docker' | 'e2b'
  binary?: string
  args?: string[]
  containerImage?: string
  sandboxTemplate?: string
  cwd?: string
  env?: Record<string, string>
}

export interface ProcessHandle {
  sessionId: string
  strategy: AgentSpec['strategy']
  pid?: number
  containerId?: string
  sandboxId?: string
}

export interface RuntimeHostCallbacks {
  onEvent(event: AgentEvent): void
  onPermission(request: unknown): Promise<unknown>
  onComplete(result: PromptResult): void
  onError(err: Error): void
}

export interface RuntimeHost {
  spawn(sessionId: string, spec: AgentSpec): Promise<ProcessHandle>
  prompt(handle: ProcessHandle, text: string, cbs: RuntimeHostCallbacks): Promise<void>
  cancel(handle: ProcessHandle): Promise<void>
  close(handle: ProcessHandle): Promise<void>
}
```

**Two implementations, same interface:**

```typescript
// packages/runtime-host/src/local.ts
// InProcessRuntimeHost — for local dev and testing.
//
// Calls child_process.spawn() directly. No HTTP server. No extra ports.
// Lives in the same Node process as the API server and Restate endpoint.
// Zero overhead — ideal for prototyping agent orchestration workflows.
//
// Uses the existing Zed ACP JSON-RPC stdio parsing logic extracted from
// ZedAcpAdapter into a pure parseZedLine() function.

export class InProcessRuntimeHost implements RuntimeHost {
  private processes = new Map<string, ChildProcess>()
  // spawn, prompt, cancel, close — all via child_process directly
}
```

```typescript
// packages/runtime-host/src/remote.ts
// RemoteRuntimeHost — for deployed/multi-tenant environments.
//
// Delegates to a persistent HTTP sidecar (Fly machine, ECS task, etc.)
// via fetch(). Same RuntimeHost interface — no VO code changes needed.
//
// The sidecar itself (packages/runtime-host/src/server.ts) is a Hono
// server that wraps InProcessRuntimeHost.

export class RemoteRuntimeHost implements RuntimeHost {
  constructor(private baseUrl: string) {}
  // Each method: fetch(`${this.baseUrl}/sessions/${id}/...`)
}
```

**Selection via environment variable:**

```typescript
// packages/runtime-host/src/index.ts

export function createRuntimeHost(): RuntimeHost {
  const mode = process.env.FLAMECAST_RUNTIME_HOST ?? 'inprocess'
  if (mode === 'inprocess') return new InProcessRuntimeHost()
  const url = process.env.FLAMECAST_RUNTIME_HOST_URL
  if (!url) throw new Error('FLAMECAST_RUNTIME_HOST_URL required when mode is remote')
  return new RemoteRuntimeHost(url)
}
```

**Local dev:** `FLAMECAST_RUNTIME_HOST=inprocess` (default). One process.
**Deployed:** `FLAMECAST_RUNTIME_HOST=remote` + `FLAMECAST_RUNTIME_HOST_URL=http://...`

### `StdioAdapter` Integration

`StdioAdapter` receives a `RuntimeHost` instance at construction and delegates
to it. The VO never touches `RuntimeHost` directly — the adapter is the only
caller.

```typescript
// packages/adapters/src/stdio.ts

export class StdioAdapter implements AgentAdapter {
  constructor(private runtimeHost: RuntimeHost) {}

  async start(config: AgentStartConfig): Promise<SessionHandle> {
    const handle = await this.runtimeHost.spawn(config.sessionId!, {
      strategy: 'local',
      binary: config.agent,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
    })
    return {
      sessionId: config.sessionId!,
      protocol: 'stdio',
      agent: { name: config.agent },
      connection: { pid: handle.pid },
    }
  }

  // promptAsync(session, text, awakeableId):
  //   Tells RuntimeHost to start driving the agent toward a terminal state.
  //   RuntimeHost will:
  //     1. Use ClientSideConnection (from @agentclientprotocol/sdk) to call
  //        connection.prompt(text) on the agent process it holds in its table.
  //     2. Stream session/update notifications to pubsub via Restate ingress
  //        as they arrive (fire-and-forget objectSendClient calls).
  //     3. When the agent reaches a terminal state (completed/awaiting/failed),
  //        resolve the awakeable by POSTing to:
  //          POST :18080/restate/awakeables/{awakeableId}/resolve
  //          { value: PromptResult }
  //        This resumes the suspended VO handler.
  //
  // Permission handling in RuntimeHost (replaces old injected callback):
  //   When ClientSideConnection fires the requestPermission callback:
  //     1. RuntimeHost creates a permission awakeable on the VO via:
  //          POST :18080/AgentSession/{sessionId}/requestPermission
  //          { request: permissionRequest }
  //        This is a NEW shared handler on AgentSession VO (see below).
  //     2. That shared handler increments the generation counter, creates a
  //        durable promise, stores pending_pause, emits the permission_request
  //        SSE event, and returns the awakeableId to RuntimeHost.
  //     3. RuntimeHost BLOCKS the SDK's requestPermission callback on this
  //        HTTP response — the callback must not return until the decision
  //        arrives. RuntimeHost polls or holds the connection open for the
  //        decision (or uses a second awakeable resolved by the UI).
  //     4. The UI's POST /api/sessions/:id/resume resolves the durable promise.
  //        RuntimeHost gets the decision, returns it from the callback, and
  //        the SDK resumes the agent.
  //
  // prompt() (streaming, for Hono SSE route):
  //   Uses ClientSideConnection.prompt() directly, yields session/update
  //   notifications as AgentEvents. Not journaled — only for live streaming.
}
```

**New shared handler on `AgentSession` VO — `requestPermission`:**

This handler is called by RuntimeHost during stdio prompt execution. It must
be `shared` (runs concurrently with the suspended `runAgent` exclusive handler):

```typescript
requestPermission: restate.handlers.object.shared(
  { enableLazyState: true },
  async (
    ctx: restate.ObjectSharedContext,
    request: unknown,
  ): Promise<{ awakeableId: string; generation: number }> => {
    // Read current generation and increment
    const gen = ((await ctx.get<number>('generation')) ?? 0) + 1
    ctx.set('generation', gen)

    // Create awakeable for this permission request
    const { id: awakeableId } = ctx.awakeable<unknown>()
    ctx.set('pending_pause', { awakeableId, generation: gen, request })

    // Publish to SSE so the UI can render the approval dialog
    ctx.objectSendClient<{ publish: (m: unknown) => void }>(
      { name: 'pubsub' }, ctx.key,
    ).publish({
      type: 'permission_request',
      awakeableId,
      generation: gen,
      request,
    })

    // Return awakeableId to RuntimeHost — RuntimeHost will block its
    // requestPermission callback waiting for this awakeable to be resolved.
    // The existing resumeAgent shared handler resolves it when the user responds.
    return { awakeableId, generation: gen }
  },
),
```

RuntimeHost receives `{ awakeableId, generation }` and must block the
`requestPermission` SDK callback until that awakeable resolves.

**Mechanism: SSE subscription.** RuntimeHost subscribes to the session's
SSE stream (`GET /api/sessions/:sessionId/events`) and listens for a
`permission_responded` event matching the `awakeableId`. When the user
clicks approve/deny in the UI, `resumeAgent` resolves the awakeable AND
emits `{ type: 'permission_responded', awakeableId, decision }` to pubsub.
RuntimeHost receives it on SSE, unblocks the SDK callback, returns the
decision to the agent.

**SSE multiplexing:** RuntimeHost should maintain a **single EventSource
per session**, not one per permission request. The same connection already
receives streaming token events. Permission handlers filter on
`event.type === 'permission_responded' && event.awakeableId === targetId`.
Open the EventSource on `spawn()`, close it on `close()`.

```typescript
// Inside InProcessRuntimeHost — permission blocking pattern:
async function awaitPermissionDecision(
  sessionId: string,
  awakeableId: string,
  sseBaseUrl: string,
): Promise<unknown> {
  // Reuse existing session EventSource, or open one
  const es = this.getOrCreateEventSource(sessionId, sseBaseUrl)
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const event = JSON.parse(e.data)
      if (event.type === 'permission_responded' && event.awakeableId === awakeableId) {
        es.removeEventListener('message', handler)
        resolve(event.decision)
      }
    }
    es.addEventListener('message', handler)
    es.onerror = () => { es.removeEventListener('message', handler); reject(new Error('SSE closed')) }
  })
}
```

The existing `resumeAgent` shared handler and `POST /api/sessions/:id/resume`
Hono route handle the UI-side resolution unchanged.

### SDK Usage in `InProcessRuntimeHost`

**Do not reimplement Zed ACP JSON-RPC parsing.** The current `ZedAcpAdapter`
uses `@agentclientprotocol/sdk`'s `ClientSideConnection`, which handles all
JSON-RPC framing internally. `InProcessRuntimeHost` should do the same:
instantiate a `ClientSideConnection` over the spawned process's stdio pipes,
exactly as `ZedAcpAdapter.start()` does today. The SDK manages line framing,
request/response correlation, and the `sessionUpdate` notification callbacks.

The "extraction" from the Go binary is about *where the process is spawned and
held* — moving from Go's `child_process` equivalent to Node's `child_process`
— not about reimplementing the protocol layer. Reuse the SDK connection
lifecycle from `ZedAcpAdapter` verbatim; the only new concern is that
`InProcessRuntimeHost` must hold the `ClientSideConnection` in its process
table (keyed by sessionId) so it survives across VO handler invocations,
since the VO itself cannot hold live connections across suspension.

### Remote Server (for deployed use)

```typescript
// packages/runtime-host/src/server.ts
// Hono server wrapping InProcessRuntimeHost.
// Only needed for deployed/multi-tenant. Not used locally.

POST   /sessions/:id/spawn    { strategy, spec }      → 201
POST   /sessions/:id/prompt   { text, callbackUrl }   → 202 (non-blocking)
POST   /sessions/:id/cancel                           → 200
DELETE /sessions/:id                                  → 204
GET    /sessions/:id/status                           → { sessionId, status, pid? }
```

`POST /prompt` is non-blocking. The server drives the agent, publishes events
to pubsub via Restate ingress, and POSTs the final `PromptResult` to
`callbackUrl` — which is a Restate awakeable resolution URL. The VO suspended
on that awakeable resumes when the POST arrives.

Permission requests in the remote server path: RuntimeHost calls back into
the session VO directly via `POST :18080/AgentSession/:sessionId/requestPermission`
(a new shared handler on the VO, detailed in Change 4 below).

### Delete the Go Binary

Once `InProcessRuntimeHost` passes end-to-end tests with existing Zed agents
(codex, claude, etc.):

1. Remove `@flamecast/session-host-go` package entirely
2. Remove all references to the Go binary from scripts and configs
3. The `HttpJsonRpcBridge` is subsumed by `RemoteRuntimeHost` + the server

---

## Change 4: Unified `AgentSession` VO

### `SessionHandle` Update

Add `protocol: 'stdio' | 'a2a'` — two wire protocols:

```typescript
export interface SessionHandle {
  sessionId: string
  protocol: 'stdio' | 'a2a'
  agent: AgentInfo
  connection: {
    url?: string           // A2A endpoint base URL
    pid?: number           // informational only
    containerId?: string   // survives RuntimeHost restart
    sandboxId?: string     // survives RuntimeHost restart
  }
}
```

`'stdio'` covers all locally-spawned agents via RuntimeHost (codex, claude,
gemini, cursor, copilot, kiro, opencode, and any other Zed ACP stdio agent).

`'a2a'` covers all HTTP agents — native A2A, Python agents (LangGraph/CrewAI/
ADK all expose A2A endpoints natively with zero config), containerized HTTP
agents, and any future HTTP agent.

### Updated `AgentAdapter` Interface

Keep the existing interface from `adapter.ts`. One change: remove
`IbmAcpAdapterInterface` as a separate extension. Promote `createRun` into the
base as optional (applies to all HTTP agents):

```typescript
export interface AgentAdapter {
  // Lifecycle
  start(config: AgentStartConfig): Promise<SessionHandle>
  cancel(session: SessionHandle): Promise<void>
  close(session: SessionHandle): Promise<void>

  // Streaming — API layer / Hono SSE route only. NOT inside ctx.run().
  prompt(session: SessionHandle, input: string | AgentMessage[]): AsyncIterable<AgentEvent>
  resume(session: SessionHandle, runId: string, payload: unknown): AsyncIterable<AgentEvent>

  // Async initiation — stdio agents only, called inside ctx.run(). Optional.
  // Hands off prompt work to RuntimeHost and returns immediately.
  // RuntimeHost resolves the VO's awakeable when the agent reaches terminal state.
  // Named "promptAsync" to distinguish from the old blocking SDK call pattern.
  promptAsync?(session: SessionHandle, input: string | AgentMessage[], awakeableId: string): Promise<void>

  // resumeSync remains for the awaiting-to-resume loop (IBM/A2A path still needs it).
  // For stdio, RuntimeHost handles resume by returning the permission decision
  // via the SDK callback — the VO's handleAwaiting loop is not used for stdio.
  resumeSync?(session: SessionHandle, runId: string, payload: unknown): Promise<PromptResult>
  // Two-phase HTTP — all HTTP agents (a2a). Optional.
  createRun?(session: SessionHandle, input: string | AgentMessage[]): Promise<{ runId: string }>

  // Config
  getConfigOptions(session: SessionHandle): Promise<ConfigOption[]>
  setConfigOption(session: SessionHandle, id: string, value: string): Promise<ConfigOption[]>
}
```

### `A2AAdapter`

Replaces `IbmAcpAdapter`. Wire protocol: A2A (JSON-RPC 2.0 over HTTP, SSE for
streaming). All existing IBM ACP agents that migrate to A2A will use this adapter.
For the transition: if you still have IBM ACP agents, keep `IbmAcpAdapter` in
place — the VO doesn't care, it calls whichever adapter is selected.

```typescript
// packages/adapters/src/a2a.ts

// Wire protocol:
//   Discovery:  GET /.well-known/agent.json  → AgentCard
//   Send:       POST /  { jsonrpc: '2.0', method: 'message/send', params }
//   Stream:     POST /  { jsonrpc: '2.0', method: 'message/stream', params }
//               → SSE of TaskStatusUpdateEvent | TaskArtifactUpdateEvent
//
// Task lifecycle: submitted → working → completed | failed | input-required
//
// start():      fetch AgentCard, return SessionHandle with endpoint URL
//
// createRun():  POST message/send, return { runId: task.id }
//               The task ID becomes the runId for SSE subscription.
//
// prompt() (streaming):
//   POST message/stream, yield AgentEvents from SSE.
//   mapA2AEvent(event) → AgentEvent | null  (pure function, unit-test it)
//     TaskArtifactUpdateEvent { parts[] }              → { type: 'text', ... }
//     TaskStatusUpdateEvent { state: 'input-required'} → { type: 'pause', ... }
//     TaskStatusUpdateEvent { state: 'completed' }     → { type: 'complete', ... }
//     TaskStatusUpdateEvent { state: 'failed' }        → { type: 'error', ... }
//
// resume():     POST message/send with contextId from prior task
// cancel():     POST tasks/cancel
// close():      no-op (stateless HTTP)

export function mapA2AEvent(event: A2ATaskEvent): AgentEvent | null
// Analogous to mapStreamEvent() in ibm-acp-adapter.ts. Pure function.
```

LangGraph, CrewAI, and Google ADK all expose A2A endpoints natively (LangGraph
auto-generates one for every assistant with zero config). Any of these agents
can be registered with an endpoint URL and used immediately with `A2AAdapter`.

### VO Implementation

```typescript
// packages/restate/src/agent-session.ts

const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000

function makeRuntime(ctx: restate.ObjectContext): AgentRuntime {
  return createRestateRuntime(ctx, { pubsubName: 'pubsub', objectName: 'AgentSession' })
}

function resolveAdapter(protocol: 'stdio' | 'a2a', runtimeHost: RuntimeHost): AgentAdapter {
  return protocol === 'stdio' ? new StdioAdapter(runtimeHost) : new A2AAdapter()
}

export const AgentSession = restate.object({
  name: 'AgentSession',
  handlers: {
    ...sharedHandlers,  // resumeAgent, getStatus, getWebhooks, cleanup

    startSession: async (ctx, input: AgentStartConfig): Promise<SessionHandle> => {
      const runtime = makeRuntime(ctx)
      const protocol = input.protocol ?? 'stdio'
      const adapter  = resolveAdapter(protocol, createRuntimeHost())
      const session  = await runtime.step('start', () => adapter.start(input))

      const now = await runtime.now()
      runtime.state.set('session', session)
      runtime.state.set('meta', {
        sessionId: ctx.key, protocol, agent: session.agent,
        status: 'active', startedAt: now, lastUpdatedAt: now,
      } satisfies SessionMeta)
      if (input.cwd) runtime.state.set('cwd', input.cwd)

      runtime.emit({ type: 'session.created', meta: await runtime.state.get('meta') })
      return session
    },

    runAgent: async (ctx, input: { text: string }): Promise<PromptResult> => {
      const runtime  = makeRuntime(ctx)
      const session  = await runtime.state.get<SessionHandle>('session')
      if (!session) throw new restate.TerminalError('No active session')
      const adapter  = resolveAdapter(session.protocol, createRuntimeHost())

      if (session.protocol === 'a2a') {
        // Two-phase pattern — identical to existing IbmAgentSession.runAgent.
        // Phase 1: journal runId (clients subscribe to agent SSE by runId)
        const { runId } = await runtime.step('create-run', () =>
          adapter.createRun!(session, input.text),
        )
        runtime.emit({ type: 'run.started', runId })

        // Phase 2: suspend until API SSE watcher resolves the awakeable
        const { id: awakeableId, promise } = ctx.awakeable<PromptResult>()
        runtime.state.set('pending_run', { awakeableId, runId })
        const result = await promise
        runtime.state.clear('pending_run')
        return handleResult(ctx, runtime, adapter, session, result)

      } else {
        // Stdio two-phase pattern — mirrors the IBM/A2A pattern exactly:
        //
        // Phase 1: create awakeable OUTSIDE ctx.run (Restate constraint: awakeables
        //   created inside ctx.run are not journaled correctly).
        const { id: awakeableId, promise } = ctx.awakeable<PromptResult>()
        //
        // Phase 2: journal the work-initiation call. StdioAdapter.promptAsync()
        //   tells RuntimeHost to start driving the agent, passing the awakeableId
        //   so RuntimeHost can resolve it when the prompt reaches a terminal state.
        //   This call returns immediately (202-style) — it does NOT block waiting
        //   for the agent to finish, which is why the awakeable is created first.
        //   IMPORTANT: promptAsync must NOT use the SDK's blocking prompt() inside
        //   ctx.run(). That path was the old ZedAgentSession pattern and is replaced.
        await runtime.step('prompt', () =>
          adapter.promptAsync!(session, input.text, awakeableId),
        )
        //
        // Phase 3: suspend here — zero compute — until RuntimeHost resolves the
        //   awakeable by POSTing to the Restate awakeable resolution endpoint.
        const result = await promise
        return handleResult(ctx, runtime, adapter, session, result)
      }
    },

    steerAgent: async (ctx, input: { newText: string; mode?: string; model?: string }): Promise<PromptResult> => {
      const runtime = makeRuntime(ctx)
      const session = await runtime.state.get<SessionHandle>('session')
      if (!session) throw new restate.TerminalError('No active session')
      const adapter = resolveAdapter(session.protocol, createRuntimeHost())

      await runtime.step('cancel', () => adapter.cancel(session))
      if (input.mode)  await runtime.step('set-mode',  () => adapter.setConfigOption(session, 'mode',  input.mode!))
      if (input.model) await runtime.step('set-model', () => adapter.setConfigOption(session, 'model', input.model!))

      // Delegate back to runAgent for the re-prompt — same VO, same pattern
      return ctx.objectClient(AgentSession, ctx.key).runAgent({ text: input.newText })
    },

    cancelAgent: async (ctx): Promise<{ cancelled: boolean }> => {
      const runtime = makeRuntime(ctx)
      const session = await runtime.state.get<SessionHandle>('session')
      if (!session) throw new restate.TerminalError('No active session')
      await runtime.step('cancel', () =>
        resolveAdapter(session.protocol, createRuntimeHost()).cancel(session),
      )
      runtime.state.clear('pending_pause')
      runtime.state.clear('pending_run')
      return { cancelled: true }
    },

    terminateSession: async (ctx): Promise<void> => {
      const runtime = makeRuntime(ctx)
      const session = await runtime.state.get<SessionHandle>('session')
      if (session) {
        await runtime.step('close', () =>
          resolveAdapter(session.protocol, createRuntimeHost()).close(session),
        )
      }
      const meta = await runtime.state.get<SessionMeta>('meta')
      if (meta) {
        runtime.state.set('meta', { ...meta, status: 'killed', lastUpdatedAt: await runtime.now() })
      }
      runtime.emit({ type: 'session.terminated' })
      runtime.scheduleCleanup(CLEANUP_DELAY_MS)
    },
  },
})
```

### `endpoint.ts` — Final Registration

```typescript
import * as restate from '@restatedev/restate-sdk'
import { AgentSession } from './agent-session.js'
import { pubsubObject } from './pubsub.js'

export const endpoint = restate.endpoint()
  .bind(AgentSession)
  .bind(pubsubObject)
  .listen(9080)
```

---

## Change 5: Agent-to-Agent Communication

The VO topology supports A2A communication without any new infrastructure.
One `AgentSession` VO can invoke another `AgentSession` VO via Restate's
typed client. This gives you durable A2A invocation for free.

### Patterns

**Sequential delegation (parent waits for child):**

```typescript
// Inside a VO handler or tool callback — parent suspends, child runs.
// Restate handles retry, exactly-once delivery, journaling.
const childResult = await ctx.objectClient(AgentSession, childSessionId)
  .runAgent({ text: delegatedPrompt })
// Parent resumes when child completes. If child fails, parent gets the error.
// The child session must already be started (startSession called first).
```

**Parallel fan-out (fire and collect):**

```typescript
// Fire multiple child sessions simultaneously.
const childPromises = childSessionIds.map((id) =>
  ctx.objectClient(AgentSession, id).runAgent({ text: subTask }),
)
// Collect results — suspends until all complete (or timeout).
const results = await RestatePromise.allSettled(childPromises)
```

**Fire-and-forget (spawn and continue):**

```typescript
// Parent continues immediately; child runs independently.
ctx.objectSendClient(AgentSession, childSessionId).runAgent({ text: subTask })
// Subscribe to child's pubsub topic to get results asynchronously.
```

### Hono API for Delegation

Add routes to support orchestrator agents initiating child sessions:

```
POST /api/sessions/:parentId/delegate
  Body: { childSessionId, agentTemplateId, text }
  → start child session + run agent
  → returns childSessionId for SSE subscription

GET /api/sessions/:id/children
  → list child sessions (from VO state 'children' key)
```

Store `children: string[]` in the orchestrator session's VO state. The
frontend can subscribe to each child's SSE topic independently.

### Compatibility with External A2A Agents

An `AgentSession` VO with `protocol: 'a2a'` that points to a LangGraph, CrewAI,
or Google ADK agent is already a node in the same mesh. The orchestrator session
calls `runAgent`, which calls `A2AAdapter.createRun()` on the external endpoint.
No distinction between internal Flamecast sessions and external A2A agents from
the orchestrator's perspective.

---

## Change 6: SSE Replay Correctness

`@restatedev/pubsub` already handles offset-based replay natively via
`Last-Event-ID`. Before writing any new code, **verify the existing
implementation** handles the following correctly:

1. SSE frame `id:` field is an integer offset, not a timestamp. Timestamps
   can collide; integer offsets cannot. Check what the current pubsub VO
   emits as the `id:` field.
2. On subscribe with `Last-Event-ID: N`, events with `offset > N` are
   replayed. Verify this is the behavior with an actual reconnect test.
3. The subscribe/`sse` handler is `shared` so it runs concurrently with
   `publish` — verify this hasn't been accidentally changed.

**If the package handles all three correctly:** no changes needed. Add a
regression test:

```typescript
// Test: publish 10 events, reconnect from offset 4,
// assert exactly 6 events received (offsets 5–10 inclusive).
```

**Only if gaps are found:** patch the specific behavior that's broken rather
than reimplementing the pubsub VO. The package's offset replay is the right
abstraction — don't replace it with a manual implementation.

**In the Hono SSE route,** verify `Last-Event-ID` is being forwarded to the
pubsub client:

```typescript
GET /api/sessions/:id/events
  const lastEventId = req.header('Last-Event-ID')
  const fromOffset  = lastEventId ? parseInt(lastEventId, 10) : -1
  // -1 means send all events from the beginning
  → pubsubClient.sse({ topic: `session:${id}`, fromOffset })
```

If the route doesn't forward `Last-Event-ID` today, that's the only fix needed.

---

## Implementation Order

Each step leaves the system running. Do not proceed until the current step's
tests pass.

### Step 1 — `AgentRuntime` interface + implementations

Files: `packages/runtime/src/types.ts`, `restate.ts`, `test.ts`

Unit tests for `createTestRuntime`:
- `step()` calls `fn()` and returns its value
- `createDurablePromise()` + `resolveDurablePromiseById()` round-trip
- `resolveDurablePromise()` throws on generation mismatch
- `state` get/set/clear operates as Map
- `emit()` appends to `events[]`
- `scheduleCleanup()` is no-op

No behavior changes to the running system at this step.

### Step 2 — Update `shared-handlers.ts`

Add `runtime: AgentRuntime` to `handleResult` and `handleAwaiting`. Replace raw
awakeable + generation logic with `runtime.createDurablePromise`. Replace
`publish()` calls with `runtime.emit()`.

Update both existing VOs (`ZedAgentSession`, `IbmAgentSession`) to construct
a runtime via `createRestateRuntime` and pass it through. System still runs
both existing VOs.

### Step 3 — `InProcessRuntimeHost`

Implement `InProcessRuntimeHost`. It must:
- Hold a `Map<sessionId, { connection: ClientSideConnection, process: ChildProcess }>`
  as its process table (in-memory; no protocol reimplementation needed)
- Reuse `@agentclientprotocol/sdk`'s `ClientSideConnection` for Zed ACP,
  exactly as `ZedAcpAdapter` does today — the SDK handles all JSON-RPC framing
- Expose `spawn`, `promptAsync`, `cancel`, `close` methods matching the
  `RuntimeHost` interface
- Resolve the VO's awakeable by POSTing to Restate's awakeable resolution
  endpoint when the prompt reaches a terminal state
- Handle permission requests by calling the VO's `requestPermission` shared
  handler (see the `requestPermission` handler spec in Change 4)

Feature-flag under `FLAMECAST_RUNTIME_HOST=inprocess`. Verify existing Zed
agent sessions (codex, claude) work end-to-end through it.

Once verified: **delete** `@flamecast/session-host-go` and all references.

### Step 4 — `StdioAdapter` + `A2AAdapter`

`StdioAdapter`: delegates to `RuntimeHost`. The key method is `promptAsync`
(not `promptSync` — it returns immediately after telling RuntimeHost to start
the agent, then the VO suspends on an awakeable). Tests use `createTestRuntime`
+ a mock `RuntimeHost` that resolves the awakeable synchronously.

Add `requestPermission` shared handler to `AgentSession` VO as specified in
Change 4. This is required before `StdioAdapter` can handle permissions.

### Step 5 — Unified `AgentSession` VO

Register `AgentSession`. **Delete** `ZedAgentSession` and `IbmAgentSession`
from `endpoint.ts` and from disk. Run full integration test suite.

### Step 6 — SSE replay correctness

Audit `pubsub.ts`. Fix offset handling. Add replay test.

### Step 7 — Agent-to-agent communication

Add delegation Hono routes. Write integration test: orchestrator session
delegates to two child sessions in parallel, collects results.

### Step 8 — `RemoteRuntimeHost` + server

Implement `RemoteRuntimeHost` and `server.ts` for deployed use.
Test by running the server in a separate process and pointing
`InProcessRuntimeHost` at it via `RemoteRuntimeHost`.

### Step 9 — Docker and E2B strategies

Implement `DockerStrategy` and `E2BStrategy` inside the RuntimeHost server.
Update `AgentSpec` to drive strategy selection.

---

## Invariants — Never Violate

**Restate is the only source of truth for session state.** RuntimeHost is
stateless with respect to session data. It can restart at any time — all
durable state lives in VO state.

**VOs never hold process handles or sockets across suspension.** `SessionHandle`
contains stable reference data (URL, container ID, sandbox ID), not live
handles. Everything non-serializable lives in RuntimeHost.

**`ctx.awakeable()` must be called synchronously in the handler body, not
inside `ctx.run()`.** This is a Restate constraint. Always create awakeables
before any `ctx.run()` that depends on them.

**Generation counter must be incremented before `createDurablePromise()` is
called.** The generation read (`ctx.get`), increment, and `ctx.set` happen
synchronously before `createDurablePromise`. See the call pattern in the
interface doc and in `handleAwaiting`.

**No Restate imports in `packages/runtime/src/types.ts`.** The interface must
be implementable without the Restate SDK.

**`endpoint.ts` is the only file where service names appear as string literals.**
All other code uses typed VO objects (`AgentSession`, not
`{ name: 'AgentSession' }`).

**The pubsub VO is append-only.** Offsets are monotonically increasing integers.
Events are never mutated or deleted.

**The VO never starts a second agent execution.** The VO is the single
authoritative execution path. Streaming consumers (SSE watcher, client browser)
subscribe to the same run, not a second invocation.

---

## Deleted Files — Do Not Recreate

- `@flamecast/session-host-go/` — entire package
- `packages/restate/src/zed-agent-session.ts`
- `packages/restate/src/ibm-agent-session.ts`
- `packages/adapters/src/ibm-acp-adapter.ts`
- `packages/adapters/src/http-bridge.ts`
- Any file importing from `acp-sdk`

---

## Current Agent Compatibility

All agents in the existing test suite are compatible with no agent-side changes:

| Agent | Protocol | Compute | Compatible? |
|---|---|---|---|
| `codex --acp` | Zed stdio | Local process | ✓ StdioAdapter + InProcessRuntimeHost |
| `claude --acp` | Zed stdio | Local process | ✓ same |
| `gemini --acp` | Zed stdio | Local process | ✓ same |
| `cursor --acp` | Zed stdio | Local process | ✓ same |
| `copilot --acp` | Zed stdio | Local process | ✓ same |
| Any Zed agent in Docker | Zed stdio | Docker | ✓ DockerStrategy in RuntimeHost |
| BeeAI / IBM ACP agents | IBM HTTP | Remote | ✓ Keep IbmAcpAdapter until migrated to A2A |
| LangGraph agent | A2A | Remote | ✓ A2AAdapter, zero agent config needed |
| CrewAI agent | A2A | Remote | ✓ same |
| Google ADK agent | A2A | Remote | ✓ same |