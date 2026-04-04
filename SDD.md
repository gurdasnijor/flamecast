# Flamecast — System Design Document

> Durable ACP gateway over Restate. Two VOs, two SDK connection classes, nothing invented.

## What Flamecast is

Flamecast is an ACP conductor (see [proxy-chains RFD](https://agentclientprotocol.com/rfds/proxy-chains)) built on Restate. It sits between upstream consumers (browsers, APIs) and downstream ACP agents (claude-agent-acp, etc). From the browser's perspective, Flamecast IS an ACP agent. From the agent process's perspective, Flamecast IS an ACP client.

```
Browser ←── Restate HTTP ──→ Flamecast ←── stdio ──→ claude-acp
         (AgentSideConnection)          (ClientSideConnection)
```

## The two interfaces from the ACP SDK

Source: `@agentclientprotocol/sdk` — [acp.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/acp.ts)

### `acp.Agent` — what clients call

| Method | Scope | Semantics |
|--------|-------|-----------|
| `initialize` | connection | Once per connection. Negotiate capabilities. |
| `authenticate` | connection | Optional. Once per connection. |
| `newSession` | connection | Creates a session, returns sessionId. |
| `listSessions` | connection | Lists all sessions for this connection. |
| `prompt` | session | Send prompt, get response. Long-running. Callbacks fire during this. |
| `cancel` | session | Abort in-flight prompt. Must run concurrent with prompt. |
| `loadSession` | session | Restore a previous session. |
| `setSessionMode` | session | Switch agent mode. |
| `setSessionConfigOption` | session | Update config. |

### `acp.Client` — what agents call back

| Method | Scope | Semantics |
|--------|-------|-----------|
| `sessionUpdate` | session | Notification (fire-and-forget). Streaming chunks, tool calls, plans. |
| `requestPermission` | session | Request-response. Agent blocks until user decides. |
| `readTextFile` | session | Request-response. Read a file from the client's filesystem. |
| `writeTextFile` | session | Request-response. Write a file. |
| `createTerminal` | session | Request-response. Create a terminal. |
| + terminal ops | session | Output, wait, kill, release. |

### Key observation

`initialize`, `newSession`, `listSessions` are **connection-scoped** — they don't have a sessionId, or they operate across sessions.

Everything else is **session-scoped** — params include `sessionId`.

## The two VOs

### `AgentConnection` VO — keyed by `clientId`

The connection-level entity. One per connected client. Implements the connection-scoped subset of `acp.Agent`.

**Handlers:**

```typescript
initialize(ctx, params: InitializeRequest): Promise<InitializeResponse>
  // Store capabilities in K/V. Return protocol version.

authenticate(ctx, params: AuthenticateRequest): Promise<AuthenticateResponse | void>
  // Store auth state.

newSession(ctx, params: NewSessionRequest): Promise<NewSessionResponse>
  // Generate sessionId (ctx.rand.uuidv4)
  // Resolve spawn config from _meta or CDN
  // Call ctx.objectClient(AgentSession, sessionId).init({ clientId, agentName, spawnConfig, cwd, mcpServers })
  // Add to session index in K/V
  // Return { sessionId }

listSessions(ctx, params: ListSessionsRequest): Promise<ListSessionsResponse>
  // Shared handler. Read session index from K/V.
```

**K/V state:** `{ capabilities, sessions: SessionInfo[] }`

### `AgentSession` VO — keyed by `sessionId`

The session-level entity. One per session. Implements both the session-scoped `acp.Agent` methods AND the `acp.Client` methods — because they're all scoped to the same sessionId.

**Agent-side handlers (called by browser via AgentConnection or directly):**

```typescript
init(ctx, params: { clientId, agentName, spawnConfig, cwd, mcpServers })
  // Internal handler called by AgentConnection.newSession
  // Store config in K/V
  // Spawn agent process (execa)
  // conn.initialize(), conn.newSession()
  // Store acpSessionId in K/V

prompt(ctx, params: PromptRequest): Promise<PromptResponse>
  // Exclusive handler
  // getOrReconnect() — cache hit or respawn from K/V
  // Set currentCtx for the toClient closure
  // await conn.prompt(params)
  // During prompt, agent callbacks fire → routed to Client handlers below

cancel(ctx, params: CancelNotification): Promise<void>
  // Shared handler — runs concurrent with prompt
  // sessions.get(ctx.key)?.conn.cancel(params)

loadSession(ctx, params: LoadSessionRequest): Promise<LoadSessionResponse>
  // Reconnect, call conn.loadSession
```

**Client-side handlers (called by downstream agent process via the toClient closure):**

```typescript
sessionUpdate(ctx, params: SessionNotification): Promise<void>
  // Store in K/V (append to updates array)
  // Push to frontend (implementation-dependent)

requestPermission(ctx, params: RequestPermissionRequest): Promise<RequestPermissionResponse>
  // Create awakeable: const { id, promise } = ctx.awakeable()
  // Store pending permission in K/V (awakeableId, toolCall, options)
  // Suspend on promise — zero resources
  // Frontend resolves via POST /restate/awakeables/{id}/resolve
  // Return { outcome }

readTextFile(ctx, params: ReadTextFileRequest): Promise<ReadTextFileResponse>
  // fs.readFile(params.path, "utf-8")

writeTextFile(ctx, params: WriteTextFileRequest): Promise<WriteTextFileResponse>
  // fs.mkdir + fs.writeFile
```

**K/V state:** `{ clientId, agentName, spawnConfig, acpSessionId, updates[], pendingPermission }`

**Module-level cache:** `sessions: Map<string, { conn: ClientSideConnection }>` — ephemeral, lost on restart, rebuilt from K/V via `getOrReconnect`.

## The downstream connection

`AgentSession` owns a `ClientSideConnection` to the agent process:

```typescript
const conn = new acp.ClientSideConnection(
  () => ({
    sessionUpdate: (p) => currentCtx.objectSendClient(AgentSession, currentCtx.key).sessionUpdate(p),
    requestPermission: (p) => currentCtx.objectClient(AgentSession, currentCtx.key).requestPermission(p),
    readTextFile: (p) => readFile(p.path, "utf-8").then(c => ({ content: c })),
    writeTextFile: (p) => mkdir(dirname(p.path), { recursive: true }).then(() => writeFile(p.path, p.content, "utf-8")).then(() => ({})),
  }),
  acp.ndJsonStream(
    Writable.toWeb(proc.stdin!),
    Readable.toWeb(proc.stdout!),
  ),
);
```

The `toClient` closure uses `currentCtx` directly — NOT inter-VO calls. The Client callbacks run inline within the prompt handler's execution context, so they have access to `ctx` for awakeables and K/V writes. No self-calling, no lock conflicts.

- `sessionUpdate` — appends to K/V directly via `currentCtx.set()`
- `requestPermission` — creates awakeable via `currentCtx.awakeable()`, stores pending permission in K/V, suspends the prompt handler. Frontend resolves via `POST /restate/awakeables/{id}/resolve`. Prompt handler resumes.
- `readTextFile` / `writeTextFile` — direct fs calls, no Restate needed.

`currentCtx` is a mutable ref set at the top of the prompt handler. This is necessary because `toClient` is called once at construction but `ctx` changes per handler invocation.

## The upstream connection (browser → Flamecast)

`createRestateStream` produces an `acp.Stream` backed by Restate HTTP:

```typescript
const stream = createRestateStream({ ingressUrl, clientId });
const agent = new acp.ClientSideConnection(() => myBrowserClient, stream);
await agent.initialize({...});
const { sessionId } = await agent.newSession({...});
await agent.prompt({ sessionId, prompt: [...] });
```

The browser uses the standard SDK `ClientSideConnection`. Same code as connecting to a local agent via stdio. Different transport.

`createRestateStream` routes:
- `initialize`, `newSession`, `listSessions` → `AgentConnection` VO (keyed by clientId)
- `prompt`, `cancel`, `loadSession` → `AgentSession` VO (keyed by sessionId from newSession response)
- Incoming `sessionUpdate` notifications → poll `AgentSession.getUpdates()` or SSE
- Incoming `requestPermission` requests → poll `AgentSession.getPendingPermission()`
- Permission responses → `POST /restate/awakeables/{id}/resolve`

## Process lifecycle

Agent processes are spawned via execa in `AgentSession.init`:

```typescript
const proc = execa(cmd, args, {
  stdin: "pipe", stdout: "pipe", stderr: "inherit",
  cleanup: true,  // kill on parent exit
});
```

- One process per session (isolation)
- `cleanup: true` ensures children die with parent
- `conn.closed` drives cache cleanup
- On restart: `getOrReconnect` respawns from K/V state, calls `loadSession`

## Files

| File | What |
|------|------|
| `src/agent-connection.ts` | `AgentConnection` VO |
| `src/agent-session.ts` | `AgentSession` VO |
| `src/client/restate-stream.ts` | `createRestateStream` — browser transport |
| `src/endpoint.ts` | `restate.serve({ services: [AgentConnection, AgentSession] })` |
| `src/index.ts` | Exports |

Deleted: `agent.ts`, `agent-client.ts`, `pubsub.ts`, `registry.ts` (inline into AgentConnection.newSession)

## Reference

- [ACP Protocol Overview](https://agentclientprotocol.com/protocol/overview)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP Proxy Chains RFD](https://agentclientprotocol.com/rfds/proxy-chains)
- [sacp-conductor](https://github.com/agentclientprotocol/symposium-acp/tree/main/src/sacp-conductor)
- [Restate Durable Sessions](https://docs.restate.dev/ai/patterns/sessions)
- [Restate TypeScript SDK](https://docs.restate.dev/develop/ts/overview)
