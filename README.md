# acp / Flamecast

Local **Agent Client Protocol (ACP)** orchestrator: spawns agent processes, holds **ACP sessions** over NDJSON on stdio, exposes a **REST API**, and ships a small **React** UI to manage connections, send prompts, and resolve permission requests.

For **planned** evolution (sandboxing, durable projection, optional Convex), see [`SPEC.md`](SPEC.md).

---

## Stack

| Layer | Technology |
|--------|------------|
| Orchestration | `Flamecast` class — in-memory state, `@agentclientprotocol/sdk` |
| Agent I/O | Local subprocesses or Docker-backed process runtime, both exposed as ACP Web Streams |
| API | [Hono](https://hono.dev/) on Node, `@hono/node-server`, port **3001**, mounted at `/api` |
| Validation | [Zod](https://zod.dev/) — shared request/response shapes in `src/shared/connection.ts` |
| Client | React 19, [Vite](https://vitejs.dev/) 8, [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query), [Tailwind](https://tailwindcss.com/) v4 |
| Typesafe API client | `hono/client` — `src/client/lib/api.ts` |

---

## Repository layout

```
src/
  client/           # Vite app (port 3000); proxies /api → 3001
    routes/         # TanStack file routes: /, /connections/$id
    components/ui/  # shadcn-style primitives
    lib/api.ts      # hc<AppType> client
  server/
    index.ts        # Hono root, route("/api", api)
    api.ts          # REST handlers → Flamecast
  flamecast/
    index.ts        # Flamecast — connections, ACP client, logs
    sandbox.ts      # Provisioner interfaces (`SandboxProvisioner`, `SandboxRuntime`)
    provisioners/   # Local + Docker provisioners
    transport.ts    # spawn + stdio → streams; built-in agent presets
    agent.ts        # example agent process (tsx) for local dev
  shared/
    connection.ts   # Zod schemas + TS types for API + Flamecast
```

---

## Runtime architecture

```mermaid
flowchart LR
  subgraph browser["Browser :3000"]
    UI["React + TanStack Query"]
  end
  subgraph node["Node :3001"]
    API["Hono /api"]
    FC["Flamecast"]
    Local["Local process runtime"]
    Docker["Docker process runtime"]
  end
  UI <-->|"HTTP /api/*"| API
  API --> FC
  FC <-->|"NDJSON ACP"| Local
  FC <-->|"NDJSON ACP"| Docker
```

- **Single process** owns all connections: one `Flamecast` instance in `api.ts`. No horizontal scaling or persistence across restarts.
- **Runtime kind** per connection: `local` (default) or `docker` via `CreateConnectionBody.runtimeKind`.

---

## Flamecast (orchestrator)

`Flamecast` (`src/flamecast/index.ts`) is the **runtime authority** for:

| Concern | Implementation |
|---------|----------------|
| Connection registry | `Map<string, ManagedConnection>` — numeric string IDs from a monotonic counter |
| Serializable snapshot | `ConnectionInfo`: label, spawn spec, `sessionId`, timestamps, `logs[]`, `pendingPermission` |
| ACP session | `ClientSideConnection` over `acp.ndJsonStream(stdin, stdout)` |
| Runtime handle | `SandboxRuntime` from a provisioner (`local` / `docker`) with a unified `dispose()` |
| Permissions | `requestPermission` from agent → UI-facing `PendingPermission` + `Map<requestId, resolver>` until user responds |

**`ManagedConnection`** pairs:

- **`info`** — what the API serializes (copy of logs on read via `snapshotInfo`).
- **`runtime`** — `ClientSideConnection | null`, `dispose()` (not sent to clients).

**Client role (ACP “client” side):** Flamecast implements `acp.Client`: session updates and tool notifications become **log entries**; `readTextFile` / `writeTextFile` are stubbed (log + empty response); `requestPermission` blocks until HTTP resolves the pending request.

**Logging:** `pushLog(managed, type, data)` appends `{ timestamp, type, data }` to `info.logs`. Types include `initialized`, `session_created`, `prompt_sent`, `prompt_completed`, `session_update`, `permission_*`, `read_text_file`, `write_text_file`, `killed`, etc.

---

## Agent processes and transport

- **`registerAgentProcess` / built-in presets** — Stored in `agentProcesses` `Map` (UUID for user-registered; built-ins use stable ids from `getBuiltinAgentProcessPresets()` in `transport.ts`, e.g. example `tsx` agent path, Codex ACP via `npx`).
- **`create`** — Requires exactly one of `agentProcessId` (preset) or inline `spawn` + optional `label`; optional `cwd`; optional `runtimeKind` (`local` default). For **`docker`**, also send **`dockerfile`** (path, absolute or relative to build context) and optional **`dockerBuildContext`** (directory passed to `docker build`; defaults to the session `cwd` on the server).
- **Provisioners** — `LocalProvisioner` preserves current behavior; `DockerProvisioner` runs `docker build -f … -t …` then `docker run --rm -i <image> <spawn.command> …<spawn.args>` (spawn comes from the chosen preset or inline body).
- **Streams** — both provisioners return the same ACP stream pair (`WritableStream` input, `ReadableStream<Uint8Array>` output).

---

## HTTP API

Base URL in dev: `http://localhost:3001/api` (browser uses `http://localhost:3000/api` via Vite proxy).

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/agent-processes` | — | List registerable agent definitions (built-ins + user-registered). |
| `POST` | `/agent-processes` | `RegisterAgentProcessBody` | Register `{ label, spawn }`; returns `AgentProcessInfo` with new `id`. |
| `GET` | `/connections` | — | List all connections (snapshots). |
| `POST` | `/connections` | `CreateConnectionBody` | Spawn agent (`runtimeKind`, optional `dockerfile` + `dockerBuildContext` for Docker), `initialize`, `newSession`; `201` + `ConnectionInfo`. |
| `GET` | `/connections/:id` | — | Snapshot for one connection; `404` if unknown. |
| `POST` | `/connections/:id/prompt` | `{ text }` | Run ACP `prompt`; returns prompt result (e.g. `stopReason`). |
| `POST` | `/connections/:id/permissions/:requestId` | `{ optionId }` or `{ outcome: "cancelled" }` | Resolve pending permission. |
| `DELETE` | `/connections/:id` | — | Kill process, remove connection. |

Schemas and TypeScript types: **`src/shared/connection.ts`**.

---

## Web client

- **Routes:** `/` — list connections, create flow; `/connections/$id` — detail, prompt input, permission card, log scroll area.
- **Data loading:** React Query `fetchConnection` / list endpoints; connection detail uses **`refetchInterval: 1000`** so logs and permission state update without push.
- **API helper:** `hc<AppType>("/api")` keeps client aligned with `src/server/api.ts` exports.

---

## Scripts

```bash
npm install
npm run dev          # API (tsx watch) + Vite in parallel
# or separately:
npm run dev:server   # API only :3001
npm run dev:client   # Vite only :3000
```

Open **http://localhost:3000**. Ensure agent binaries (e.g. `npx`, `tsx`) are available if you use presets that need them.

For Docker runtime:

- Install Docker and ensure the `docker` CLI is on `PATH`.
- Provide a **`dockerfile`** path the server can read; **`dockerBuildContext`** is the directory sent to `docker build` (defaults to the connection `cwd`, usually the API server’s current working directory if unset).
- The image is tagged per connection (`flamecast/agent:conn-<id>`), removed on **`DELETE /connections/:id`** (best-effort `docker rmi`). Treat arbitrary Dockerfiles as **trusted** input on the host — this is not a multi-tenant sandbox yet.

Other scripts: `npm run build`, `npm start` (production build entry — verify `dist` layout for your deploy target), `npm run lint`, `npm run format`, `npm run cli` (separate entrypoint in `src/index.ts`; may not match the latest `CreateConnectionBody` shape).

---

## Current limitations (by design)

- **No durable store** — restart clears connections and logs.
- **No auth** — local dev assumption; do not expose raw to the internet.
- **Single host** — one Node process; no sticky sessions or distributed Flamecast.
- **Push updates** — UI relies on polling, not SSE/WebSocket (see `SPEC.md` if that changes).

---

## Related documentation

- **[`SPEC.md`](SPEC.md)** — phased roadmap (sandbox orchestration, projection port, optional Convex).
- **ACP** — protocol and behavior via `@agentclientprotocol/sdk`.
