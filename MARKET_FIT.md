# Market Fit Evaluation

## Would someone actually use Flamecast?

**Yes** — for a specific and growing audience.

## What it is

Flamecast is a self-hostable control plane for ACP (Agent Client Protocol)-compatible agents. It handles session lifecycle, permission brokering, real-time streaming, and provides a React dashboard — essentially an orchestration layer for running and monitoring AI coding agents.

## Who would use it

### 1. Teams deploying AI coding agents in production or semi-production settings

If you're running Claude Code, Codex, or any ACP-compatible agent as part of an internal workflow (CI-triggered code reviews, automated refactoring, batch migrations), you currently have no good way to manage those sessions centrally. Flamecast fills that gap — launch sessions, stream logs, approve/deny permission requests from a dashboard, and persist history.

### 2. Platform builders integrating agents into their products

Anyone building a product that wraps AI agents (a coding assistant, an internal dev tool, an agent marketplace) needs exactly this kind of infrastructure. Flamecast gives them session management, multi-runtime support (local, Docker, E2B), and a WebSocket event protocol they can build on instead of rolling their own.

### 3. Agent developers who need a local dev/debug harness

When building an ACP-compatible agent, having a UI that shows live events, permission requests, and filesystem snapshots is genuinely useful for development. The in-memory storage mode and local runtime make it easy to spin up.

## Why it matters (the market timing argument)

- **ACP is emerging as a standard** for agent-editor communication. As more agents adopt it, the need for infrastructure around it grows.
- **Permission brokering is a real unsolved problem.** Agents that take actions need human approval flows. Most current solutions are ad-hoc. Flamecast makes this a first-class feature.
- **Multi-runtime is non-trivial.** Supporting local processes, Docker containers, and E2B sandboxes from a single API is meaningful — teams shouldn't have to rebuild this.

## Honest risks / gaps

- **No auth or multi-tenancy yet** — limits production use to trusted environments.
- **Single-process architecture** — not ready for high-scale distributed deployments.
- **ACP adoption is still early** — the addressable market depends on ACP becoming a real standard rather than a niche protocol.
- **Competes with "just use the CLI"** — many teams are fine running agents ad-hoc. The value of a control plane only becomes clear at scale or when you need audit trails and permission flows.

## Bottom line

Flamecast is infrastructure for the agent orchestration layer — a space that barely exists today but is forming quickly. It's most useful right now for platform builders and teams running agents at any meaningful scale. The bet is that ACP adoption grows and the need for managed agent sessions becomes obvious, at which point Flamecast is well-positioned as the open-source default.
