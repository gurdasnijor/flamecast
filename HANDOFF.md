# Handoff — ACP Durable Sessions (mono-b1s2)

> Written 2026-04-03 after a long session. Start here.

## Where we are

The session rewrite is architecturally sound but has one blocking bug preventing local dev from working. The transport layer and ACP compliance tests are solid.

### What works
- **38 ACP compliance tests** pass against real `claude-acp` through Restate (initialization, sessions, prompts, permissions, file I/O, tool calls, terminals, plans, modes, config options, slash commands, cancellation, errors)
- **Transport primitives** — `fromStdio`, `fromWebSocket`, `fromHttpSse` produce `acp.Stream`. `connectX`/`serveX` are one-liner compositions. `bridge()` pipes two streams in 4 lines.
- **Session VO** — `session.ts` is self-contained. VO state is the agent handle. `ctx.run("agent_init")` journals `acpSessionId` for replay determinism.
- **Session host** — `createSessionHost(cmd, args)` manages persistent processes keyed by sessionId.

### What's broken
**"unexpected closed request stream"** — When a Restate handler calls `fromStdio` → `ndJsonStream` → `ClientSideConnection`, the `acp.Stream` works for the first handler invocation but breaks on subsequent ones. The `Writable.toWeb(proc.stdin)` Web Stream wrapper closes when the first handler returns, killing the pipe to the subprocess.

**Root cause**: Node's `Writable.toWeb()` creates a Web Stream that's tied to the handler's lifecycle. When the handler returns and the `ClientSideConnection` is GC'd, the Web Stream closes, which closes the underlying Node stream, which closes stdin on the subprocess.

**Fix**: Replace `spawn` + `Writable.toWeb` with `execa` which provides native Web Streams with proper lifecycle. See `bd show mono-v2o2` for the full design.

## Architecture

```
Client (browser/API)
  → FlamecastClient (implements acp.Agent, calls Restate ingress)
    → AcpSession VO (Restate Virtual Object)
      → resolveAgent(name, sessionId, toClient)
        → stdio: session host (persistent process per session)
        → ws/http: connectWs/connectHttpSse (fresh connection, cheap)
      → ClientSideConnection (ACP SDK — IS an Agent)
        → agent.initialize() / agent.newSession() / agent.prompt()
```

### Transport layers (packages/acp/src/transports/)

Three composable layers:
1. **Primitives**: `fromStdio`, `fromWebSocket`, `fromHttpSse` → `acp.Stream`
2. **Terminate**: `connectX(opts, toClient)` = `new ClientSideConnection(toClient, fromX(opts))`
3. **Proxy**: `bridge(accept, connect)` = `accept(in => { const out = connect(); pipeTo both directions })`

The `acp.Stream` type is from the SDK: `{ readable: ReadableStream<AnyMessage>, writable: WritableStream<AnyMessage> }`. It's what `ClientSideConnection` and `AgentSideConnection` consume. The SDK's `ndJsonStream(output, input)` produces it from raw byte streams.

### Key reference: how claude-agent-acp starts

```ts
// https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts#L2165
const input = nodeToWebWritable(process.stdout);
const output = nodeToWebReadable(process.stdin);
const stream = ndJsonStream(input, output);
new AgentSideConnection((client) => new ClaudeAcpAgent(client), stream);
```

Our `fromStdio` is the mirror: same `ndJsonStream`, opposite direction.

### Session lifecycle in Restate

- `newSession` handler: `ctx.run("agent_init")` journals `acpSessionId`. Fresh `ClientSideConnection` per handler.
- `prompt` handler: `reconnectAgent(ctx)` connects fresh, initializes, tries `loadSession` (falls back to new session + replay from history). Re-reads `acpSessionId` from state after reconnect since it may have changed.
- VO state: `agentName`, `acpSessionId`, `agentCapabilities`, `history[]`, `meta`
- No module-level connection cache in session.ts. The session host (server-level) manages process persistence.

## What to do next

### 1. Fix the stream bug (mono-v2o2, P1)
```bash
pnpm add execa  # in packages/acp
```
Replace `spawn` in `fromStdio` with execa. The session host Map becomes safe because `cleanup: true` ensures children die with parent. See `bd show mono-v2o2` for full design.

### 2. Simplify the @flamecast/acp package
The package has accumulated complexity that should be pruned:
- `bridge-server.ts` — standalone bridge server, not needed for local dev
- `session-host.ts` — collapses to ~10 lines with execa
- `codec.ts` + `transport.ts` — only used by `AcpClient` (test utility). Not part of the user-facing API.

The goal: **no complex server processes for running N local ACP agent instances**. Just spawn processes, keep them in a Map, pipe streams. The heavy infrastructure (bridges, containers, HTTP servers) is for deployed contexts only.

### 3. Test remote agents through Restate
The transport composition tests prove WS and stdio work independently. The missing test: Restate handler → `connectWs(bridge)` → bridge → stdio agent → response. This validates the deployed architecture where the control plane (CF Worker) talks to a data plane (container) over WS.

### 4. Fix 2 minor compliance test failures
- Terminal completed status: increase SSE wait from 500ms to 1500ms
- Permission options: change prompt from `echo` (doesn't always trigger permission) to file write

## Beads
- `bd show mono-b1s2` — umbrella issue with full migration checklist + notes
- `bd show mono-v2o2` — execa migration with design doc
- `bd show mono-maks` — ctx.run durability (code written, needs e2e test)
- `bd show mono-nlve` — cancel wiring (code written, needs e2e test)
- `bd show mono-5k7v` — custom Restate serialization (P3, exploration)

## Files changed this session
```
Deleted: pool.ts, factory.ts, resolver.ts, agents.ts, agent-handle.ts, connections.ts
New:     codec.ts, session-host.ts, bridge-server.ts, bridge.ts, transport-composition.test.ts
Changed: session.ts, endpoint.ts, index.ts (barrel), client/index.ts,
         stdio.ts, websocket.ts, http-sse.ts, acp-compliance.test.ts,
         session-e2e.test.ts, package-contract.test.ts, server/index.ts,
         ARCHITECTURE.md, acp/package.json
```
