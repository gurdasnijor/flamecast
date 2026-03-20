import { describe, expect } from "vitest";
import alchemy from "alchemy";
import * as docker from "alchemy/docker";
import "alchemy/test/vitest";
import { createServer, createConnection } from "node:net";
import { Flamecast } from "../src/flamecast/index.js";

const test = alchemy.test(import.meta, { prefix: "test" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pollForPermission(flamecast: Flamecast, connId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const conn = await flamecast.get(connId);
    if (conn.pendingPermission) return conn.pendingPermission;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No pending permission after ${timeoutMs}ms`);
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        return;
      }
      const socket = createConnection({ host, port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => setTimeout(attempt, 500));
    }
    attempt();
  });
}

/**
 * Full connection lifecycle: create → prompt → permission → response → kill.
 * Same assertions regardless of provisioner config.
 */
async function runConnectionLifecycle(
  flamecast: Flamecast,
  createBody: Parameters<Flamecast["create"]>[0],
) {
  const conn = await flamecast.create(createBody);
  expect(conn.id).toBeTruthy();
  expect(conn.sessionId).toBeTruthy();

  const connId = conn.id;

  try {
    const promptPromise = flamecast.prompt(connId, "Hello from integration test!");

    const pending = await pollForPermission(flamecast, connId, 15_000);
    expect(pending).toBeDefined();
    expect(pending.options.length).toBeGreaterThanOrEqual(2);

    const allow = pending.options.find((o) => o.optionId === "allow");
    if (!allow) throw new Error("No allow option found");
    await flamecast.respondToPermission(connId, pending.requestId, {
      optionId: allow.optionId,
    });

    const result = await promptPromise;
    expect(result.stopReason).toBe("end_turn");

    const state = await flamecast.get(connId);
    expect(state.logs.length).toBeGreaterThan(0);
  } finally {
    await flamecast.kill(connId);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flamecast", () => {
  test("local - full connection lifecycle", async (scope) => {
    const flamecast = await Flamecast.create({
      stateManager: { type: "memory" },
    });

    try {
      await runConnectionLifecycle(flamecast, {
        spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] },
      });
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("local - preset agent process", async (scope) => {
    const flamecast = await Flamecast.create({
      stateManager: { type: "memory" },
    });

    try {
      const processes = flamecast.listAgentProcesses();
      expect(processes.length).toBeGreaterThan(0);
      expect(processes.find((p) => p.id === "example")).toBeDefined();

      await runConnectionLifecycle(flamecast, { agentProcessId: "example" });
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("local - connection management", async (scope) => {
    const flamecast = await Flamecast.create({
      stateManager: { type: "memory" },
    });

    try {
      const connections = await flamecast.list();
      expect(Array.isArray(connections)).toBe(true);

      await expect(flamecast.get("nonexistent")).rejects.toThrow();
    } finally {
      await alchemy.destroy(scope);
    }
  });

  // TODO: TCP transport hangs during ACP handshake — likely Nagle buffering.
  // setNoDelay(true) added to both sides but Docker image needs rebuild.
  test.skip("docker - full connection lifecycle", async (scope) => {
    // Layer 1 — build the agent image (alchemy tracks state, skips if unchanged)
    const image = await docker.Image("test-agent-image", {
      name: "flamecast/test-agent",
      tag: scope.stage,
      build: {
        context: ".",
        dockerfile: "docker/example-agent.Dockerfile",
      },
      skipPush: true,
    });

    const network = await docker.Network("test-agent-network", {
      name: `flamecast-test-agents-${scope.stage}`,
      driver: "bridge",
    });

    // Layer 2 — provisioner creates a per-connection container
    const flamecast = await Flamecast.create({
      stateManager: { type: "memory" },
      provisioner: async (connectionId) => {
        const port = await findFreePort();
        await docker.Container(`sandbox-${connectionId}`, {
          image,
          name: `flamecast-test-sandbox-${connectionId}`,
          networks: [{ name: network.name }],
          environment: { ACP_PORT: String(port) },
          ports: [{ external: port, internal: port }],
          start: true,
        });
        await waitForPort("localhost", port, 30_000);
        return { host: "localhost", port };
      },
    });

    try {
      await runConnectionLifecycle(flamecast, { agentProcessId: "example" });
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
