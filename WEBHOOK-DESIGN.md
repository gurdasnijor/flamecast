# Flamecast Webhook Architecture — Two-Tier Design

## Overview

Event delivery from session-host to the outside world uses two tiers:

- **Tier 1 (Internal callbacks)**: session-host → control plane → in-process handlers
- **Tier 2 (External webhooks)**: control plane → user-registered HTTP endpoints

Tier 1 is implemented on `feat/permission-callback`. Tier 2 layers on top.

## Tier 1 — Internal Callbacks (Implemented)

### Flow

```
Agent → ACP → Session-host
  → POST {callbackUrl}/agents/{sessionId}/events
    → Control plane handleSessionEvent()
      → onPermissionRequest(ctx)   [sync — blocks until handler returns]
      → onSessionEnd(ctx)          [fire-and-forget]
      → onAgentMessage(ctx)        [fire-and-forget]
      → onError(ctx)               [fire-and-forget]
    ← HTTP response (permission: {optionId} or {deferred:true}; others: {ok:true})
```

### Protocol types

```typescript
type SessionCallbackEvent =
  | { type: "permission_request"; data: PermissionRequestEvent }
  | { type: "session_end"; data: { exitCode: number | null } }
  | { type: "agent_message"; data: { sessionUpdate: unknown } }
  | { type: "error"; data: { message: string } };

type PermissionCallbackResponse =
  | { optionId: string }
  | { outcome: "cancelled" }
  | { deferred: true };
```

### Key behaviors

- `callbackUrl` flows: `FlamecastOptions` → `SessionService` → `/start` body → session-host state
- Permission requests are synchronous (session-host blocks on HTTP POST)
- If handler returns `undefined`, control plane responds `{ deferred: true }` and session-host falls back to WS-based UI flow
- Other events are fire-and-forget (`void postCallback(...)`)
- All handler errors are caught and logged, never break session state

## Tier 2 — External Webhooks (To Build)

### Architecture

`handleSessionEvent` is the fan-out point. After in-process handlers run, also deliver to registered external webhooks:

```
handleSessionEvent(sessionId, event)
  ├── dispatch to in-process handler     ← Tier 1 (exists)
  └── deliver to external webhook URLs   ← Tier 2 (to build)
       ├── HMAC-SHA256 signing
       ├── Retry with exponential backoff
       └── Event type filtering
```

No changes to Tier 1 code needed. External delivery is additive.

### Comparison

| | Tier 1 (Internal) | Tier 2 (External) |
|---|---|---|
| Who calls | Session-host → control plane | Control plane → user's endpoint |
| Auth | Trust boundary, no auth | HMAC-SHA256 signed |
| Events | All 4 types | `end_turn`, `permission_request`, `error` (coalesced) |
| Delivery | Single POST, synchronous | At-least-once, retry with backoff |
| Config | `callbackUrl` in `/start` body (automatic) | `webhooks[]` on constructor or session creation |

### Registration

Two levels, merged at runtime:

**Global (constructor):**
```typescript
new Flamecast({
  runtimes: { ... },
  callbackUrl: "http://localhost:3001/api",
  webhooks: [
    { url: "https://my-app.com/events", secret: "whsec_abc", events: ["end_turn", "error"] }
  ],
})
```

**Per-session (creation):**
```json
POST /api/agents
{
  "agentTemplateId": "codex",
  "webhooks": [
    { "url": "https://my-app.com/permissions", "secret": "whsec_def", "events": ["permission_request"] }
  ]
}
```

### Webhook delivery engine

Standalone module: `packages/flamecast/src/flamecast/webhook-delivery.ts`

```typescript
interface WebhookConfig {
  url: string;
  secret: string;
  events?: string[];  // filter — omit for all events
}

class WebhookDeliveryEngine {
  deliver(sessionId: string, type: string, data: Record<string, unknown>): Promise<void>
}
```

- HMAC-SHA256 signing with shared secret
- Headers: `X-Flamecast-Signature`, `X-Flamecast-Event-Id`, `X-Flamecast-Session-Id`
- Retry with exponential backoff: immediate, 5s, 30s, 2m, 10m (5 attempts)
- 10-second timeout per attempt
- Event type filtering per webhook registration

### Async permission flow (external)

External permissions are async — a Slack user might respond minutes later. This requires an inbound endpoint.

**Outbound** (control plane → user's endpoint): "permission request happened"
**Inbound** (user's endpoint → control plane): "here's the user's answer"

```
1. Session-host POSTs permission_request to control plane (Tier 1)
2. onPermissionRequest handler returns undefined (deferred)
3. Control plane responds { deferred: true }
4. Session-host falls back to WS promise (existing behavior)
5. Control plane fires webhook to user's endpoint
6. ... time passes, Slack user clicks "allow" ...
7. User's server POSTs to POST /api/agents/:id/permissions/:requestId
8. Control plane forwards response to session-host via WS permission.respond
9. Session-host resolves promise, agent continues
```

Step 8 reuses the existing WS permission resolution path — the control plane acts as a WS client sending `{ action: "permission.respond", requestId, body: { optionId } }`.

### Implementation order

1. **Webhook delivery engine** — standalone module, HMAC + retry + filtering
2. **`webhooks[]` on `FlamecastOptions`** — config surface
3. **Fan-out in `handleSessionEvent`** — one line: `void this.webhookEngine.deliver(...)`
4. **`POST /agents/:id/permissions/:requestId`** — inbound endpoint, bridges to session-host via WS

## RFC alignment

This design implements https://flamecast.mintlify.app/rfcs/webhooks with one simplification: the RFC assumes webhooks are the primary delivery mechanism. Our approach makes in-process handlers primary (Tier 1) and webhooks secondary (Tier 2). This means:

- Simple cases (auto-approve, policy rules) need zero webhook infrastructure
- Complex cases (Slack bots, external orchestrators) add webhooks on top
- The two tiers compose — a handler can auto-approve known operations and defer others to webhooks
