# Flamecast

Open-source **ACP (Agent Client Protocol)** orchestrator. Provides a REST API to run, observe, and control AI coding agents. Ships a React web UI as a reference frontend.

See [`PRD.md`](PRD.md) for product context, [`SPEC.md`](SPEC.md) for architecture, and [`RFC.md`](RFC.md) for the implementation plan.

---

## Architecture

Flamecast separates **control plane** (where the server and database run) from **data plane** (how agent connections are provisioned per-request).

### Control plane — `flamecast-infra`

Declared in [`alchemy.run.ts`](alchemy.run.ts) as an [Alchemy](https://alchemy.run) resource graph. Provisioned once per stage at deploy time.

| Resource | Provider | Purpose |
|---|---|---|
| Database | `alchemy/docker` — Postgres 16 | Persistent state (connections, logs) |
| API server | `alchemy/cloudflare` — Worker | Flamecast HTTP API on port 3001 |
| Frontend | `alchemy/cloudflare` — Vite | React UI |

Resources are stage-isolated: each developer, PR, and production environment gets its own namespaced infrastructure via `--stage`.

### Data plane — `flamecast`

Runs inside the server at request time. Each agent connection gets its own [Alchemy scope](https://alchemy.run/concepts/scope/). The **provisioner** creates agent resources within that scope — `docker.Container`, `cloudflare.Container`, or any Alchemy resource.

```
POST /connections      → Alchemy scope created → provisioner runs → agent starts
DELETE /connections/:id → transport.dispose()   → scope destroyed  → agent cleaned up
```

The provisioner is a function: `(connectionId, spec) => Promise<AcpTransport>`. Default is a local `ChildProcess` via stdio. Docker, Cloudflare Containers, and custom provisioners are passed via `FlamecastOptions`.

### Separation of concerns

```
alchemy.run.ts          → control plane (deploy-time, Alchemy resources)
src/server/index.ts     → Node entry point (local dev)
src/worker.ts           → Cloudflare Worker entry point (cloud deploy)
src/flamecast/index.ts  → orchestration core (zero infra deps, pure ACP)
src/flamecast/api.ts    → Hono routes (HTTP adapter)
src/flamecast/config.ts → factory + Alchemy scope wrapping
```

`Flamecast` (the class) has zero Alchemy imports. It calls `this.provisioner(id, spawn)` and gets a transport. Infrastructure concerns (alchemy scopes, DB setup, server wiring) live outside the class.

---

## Development

### Quick start (Node, no Alchemy)

```bash
pnpm install
pnpm dev          # API (tsx watch :3001) + Vite (:3000)
```

Open **http://localhost:3000**. Uses PGLite on disk (`.acp/pglite/`). Agents run as local child processes.

### Full stack via Alchemy

```bash
pnpm alchemy:dev  # Provisions DB (Docker Postgres), API (miniflare :3001), Vite frontend
```

This runs `alchemy.run.ts` which provisions:
- Postgres 16 in Docker
- Flamecast API as a Cloudflare Worker (via miniflare locally)
- Vite frontend

Hot reloads on code changes.

### Individual services

```bash
pnpm dev:server   # API only (:3001)
pnpm dev:client   # Vite only (:3000)
```

---

## Deployment

All deployment uses [Alchemy CLI](https://alchemy.run/concepts/cli/).

```bash
pnpm alchemy:deploy                   # Deploy to personal stage ($USER)
pnpm alchemy:deploy -- --stage pr-42  # PR preview environment
pnpm alchemy:deploy -- --stage prod   # Production
pnpm alchemy:destroy -- --stage pr-42 # Tear down PR environment
```

Each stage gets isolated infrastructure — database, server, and frontend namespaced by stage. A developer's containers can't collide with production.

---

## Stack

| Layer | Technology |
|---|---|
| Orchestration | `Flamecast` class + pluggable `Provisioner` + `FlamecastStateManager` |
| Agent I/O | `AcpTransport` — stdio (local), TCP (Docker), extensible |
| Infrastructure | [Alchemy](https://alchemy.run) — Docker, Cloudflare Workers, Vite |
| API | [Hono](https://hono.dev/), `@hono/zod-validator` |
| Validation | [Zod](https://zod.dev/) — shared schemas in `src/shared/connection.ts` |
| Database | Postgres (Docker) or PGLite (embedded), [Drizzle ORM](https://orm.drizzle.team/) |
| Client | React 19, Vite 8, TanStack Router + Query, Tailwind v4 |
| Typesafe API client | `hono/client` — `src/client/lib/api.ts` |

---

## Repository layout

```
alchemy.run.ts            # Control plane: DB + Worker + Vite (Alchemy resource graph)
src/
  worker.ts               # Cloudflare Worker entry point (exports Hono fetch handler)
  server/
    index.ts              # Node entry point (local dev, tsx watch)
  flamecast/
    index.ts              # Flamecast — pure orchestration core (no infra deps)
    api.ts                # Hono routes → Flamecast methods
    config.ts             # FlamecastOptions, createFlamecast() factory, Alchemy scope wrapping
    transport.ts           # AcpTransport, openLocalTransport (stdio), openTcpTransport (TCP)
    agent.ts              # Example ACP agent (tsx, supports stdio + TCP via ACP_PORT)
    state-manager.ts      # FlamecastStateManager interface
    state-managers/
      memory/             # In-memory implementation
      psql/               # Drizzle + Postgres/PGLite implementation
    db/
      client.ts           # createDatabase() — Postgres URL or PGLite on disk
    resources/
      pglite.ts           # PGLite as an Alchemy resource
  client/                 # React app (Vite, port 3000)
    routes/               # TanStack file routes: /, /connections/$id
    lib/api.ts            # hc<AppType> typed client
  shared/
    connection.ts         # Zod schemas + TS types (API + Flamecast)
docker/
  example-agent.Dockerfile  # Agent container image (TCP mode via ACP_PORT)
test/
  flamecast.test.ts       # Integration tests (orchestration core)
  api.test.ts             # API contract tests (through Hono)
```

---

## HTTP API

Base URL: `http://localhost:3001/api`

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/health` | — | Health check (state manager status, connection count) |
| `GET` | `/agent-processes` | — | List agent definitions (built-ins + registered) |
| `POST` | `/agent-processes` | `RegisterAgentProcessBody` | Register a custom agent |
| `GET` | `/connections` | — | List all connections |
| `POST` | `/connections` | `CreateConnectionBody` | Create connection (spawn agent, ACP init) |
| `GET` | `/connections/:id` | — | Connection details + logs |
| `POST` | `/connections/:id/prompt` | `{ text }` | Send prompt to agent |
| `POST` | `/connections/:id/permissions/:requestId` | `{ optionId }` or `{ outcome: "cancelled" }` | Resolve permission request |
| `DELETE` | `/connections/:id` | — | Kill connection + cleanup |

---

## Testing

```bash
pnpm test         # Run all integration + API contract tests
```

Tests use [Alchemy's test pattern](https://alchemy.run/concepts/testing/) — each test gets an isolated scope via `alchemy.test()`, with `alchemy.destroy(scope)` cleanup in `finally`.

- **`test/flamecast.test.ts`** — Tests orchestration directly: connection lifecycle, presets, provisioner patterns (local + Docker)
- **`test/api.test.ts`** — Tests HTTP contract through Hono: status codes, response shapes, full lifecycle via `hc` typed client

---

## Configuration

Flamecast is configured via TypeScript — no config files.

```typescript
// Local dev (default)
const flamecast = await createFlamecast();

// Custom state manager
const flamecast = await createFlamecast({
  stateManager: { type: "postgres", url: process.env.DATABASE_URL },
});

// Custom provisioner (Docker containers per connection)
const flamecast = await createFlamecast({
  provisioner: async (connectionId, spec) => {
    const container = await docker.Container(`sandbox-${connectionId}`, {
      image: "my-agent",
      environment: { ACP_PORT: "9100" },
      ports: [{ external: 9100, internal: 9100 }],
      start: true,
    });
    return openTcpTransport("localhost", 9100);
  },
});
```

See [`FlamecastOptions`](src/flamecast/config.ts) for the full type.

---

## Current limitations

- **No auth** — local dev assumption. Do not expose to the internet without adding auth.
- **Single host** — one process owns all agent connections. No horizontal scaling.
- **Poll-based updates** — UI polls `GET /connections/:id` on an interval, not SSE/WebSocket.
- **Local provisioner can't reconnect** — if the orchestrator dies, local agent sessions are lost. Docker/remote provisioners support reconnection via Alchemy scope state.

---

## Related documentation

- [`PRD.md`](PRD.md) — Product requirements
- [`SPEC.md`](SPEC.md) — Architecture spec
- [`RFC.md`](RFC.md) — Implementation plan
- [Alchemy](https://alchemy.run) — Infrastructure as TypeScript
- [ACP](https://github.com/anthropics/agent-client-protocol) — Agent Client Protocol
