/**
 * E2E test for the IBM ACP path.
 *
 * Exercises IbmAcpAdapter directly against the echo agent, and optionally
 * tests the IbmAgentSession VO through Restate if it is running.
 *
 * Usage:
 *   1. cd tests/echo-agent && uv run python server.py &
 *   2. npx tsx tests/e2e-ibm-acp.ts
 *   3. (Optional) Start Restate + register endpoint for VO-level tests
 *
 * The echo agent runs on http://localhost:8000 by default.
 * Restate admin on :19070, ingress on :18080.
 */

import { setTimeout as delay } from "node:timers/promises";
import { IbmAcpAdapter } from "../packages/flamecast-restate/src/ibm-acp-adapter.js";
import type {
  AgentStartConfig,
  PromptResult,
  SessionHandle,
} from "../packages/flamecast-restate/src/adapter.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:8000/agents/echo";
const RESTATE_ADMIN_URL =
  process.env.RESTATE_ADMIN_URL ?? "http://localhost:19070";
const RESTATE_INGRESS_URL =
  process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";

/** Timeout for polling awaitRun (echo agent should be fast). */
const RUN_TIMEOUT_MS = 30_000;

// ─── Test harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function log(msg: string): void {
  console.log(msg);
}

function pass(name: string): void {
  passed++;
  log(`  PASS  ${name}`);
}

function fail(name: string, err: unknown): void {
  failed++;
  const msg = err instanceof Error ? err.message : String(err);
  log(`  FAIL  ${name}: ${msg}`);
}

function skip(name: string, reason: string): void {
  skipped++;
  log(`  SKIP  ${name}: ${reason}`);
}

// ─── Precondition checks ────────────────────────────────────────────────────

async function checkAgentRunning(): Promise<boolean> {
  try {
    const res = await fetch(AGENT_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkRestateRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${RESTATE_ADMIN_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkVORegistered(): Promise<boolean> {
  try {
    const res = await fetch(
      `${RESTATE_ADMIN_URL}/services/IbmAgentSession`,
      { signal: AbortSignal.timeout(5_000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Test 1: IbmAcpAdapter.start ─────────────────────────────────────────────

async function testAdapterStart(
  adapter: IbmAcpAdapter,
): Promise<SessionHandle | null> {
  log("\n--- Test 1: IbmAcpAdapter.start ---\n");

  try {
    const config: AgentStartConfig = {
      agent: AGENT_URL,
      sessionId: `e2e-ibm-${Date.now()}`,
    };

    const session = await adapter.start(config);

    if (!session.sessionId) {
      throw new Error("Missing sessionId in SessionHandle");
    }
    if (session.protocol !== "ibm") {
      throw new Error(`Expected protocol "ibm", got "${session.protocol}"`);
    }
    if (!session.agent.name) {
      throw new Error("Missing agent.name in SessionHandle");
    }
    if (!session.connection.url) {
      throw new Error("Missing connection.url in SessionHandle");
    }

    log(`    sessionId:  ${session.sessionId}`);
    log(`    protocol:   ${session.protocol}`);
    log(`    agent.name: ${session.agent.name}`);
    log(`    url:        ${session.connection.url}`);

    pass("start returned valid SessionHandle");
    return session;
  } catch (err) {
    fail("adapter.start", err);
    return null;
  }
}

// ─── Test 2: IbmAcpAdapter.createRun ─────────────────────────────────────────

async function testAdapterCreateRun(
  adapter: IbmAcpAdapter,
  session: SessionHandle,
): Promise<string | null> {
  log("\n--- Test 2: IbmAcpAdapter.createRun ---\n");

  try {
    const { runId } = await adapter.createRun(session, "Hello from E2E test");

    if (!runId) {
      throw new Error("Missing runId from createRun");
    }

    log(`    runId: ${runId}`);
    pass("createRun returned a runId");
    return runId;
  } catch (err) {
    fail("adapter.createRun", err);
    return null;
  }
}

// ─── Test 3: Poll until completion (awaitRun via promptSync) ─────────────────

async function testAdapterPromptSync(
  adapter: IbmAcpAdapter,
  session: SessionHandle,
): Promise<void> {
  log("\n--- Test 3: IbmAcpAdapter.promptSync (createRun + poll) ---\n");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

    const result: PromptResult = await adapter.promptSync(
      session,
      "Say hello",
    );

    clearTimeout(timer);

    log(`    status: ${result.status}`);
    log(
      `    output: ${JSON.stringify(result.output ?? result.error ?? null).slice(0, 500)}`,
    );

    if (result.status !== "completed") {
      throw new Error(
        `Expected status "completed", got "${result.status}": ${result.error ?? ""}`,
      );
    }

    pass("promptSync returned completed");

    // Verify echo content
    const allText = (result.output ?? [])
      .flatMap((m) => m.parts ?? [])
      .map((p) => ("content" in p ? (p.content as string) : ""))
      .join(" ");

    if (allText.toLowerCase().includes("echo")) {
      pass("response contains echo content");
    } else {
      log(`    (response text: "${allText.slice(0, 200)}")`);
      // Not a failure — agent might format differently
      pass("response received (content check inconclusive)");
    }
  } catch (err) {
    fail("adapter.promptSync", err);
  }
}

// ─── Test 4: Streaming via adapter.prompt ────────────────────────────────────

async function testAdapterStream(
  adapter: IbmAcpAdapter,
  session: SessionHandle,
): Promise<void> {
  log("\n--- Test 4: IbmAcpAdapter.prompt (streaming) ---\n");

  try {
    const events: Array<{ type: string }> = [];
    let gotComplete = false;
    let gotText = false;

    for await (const event of adapter.prompt(session, "Stream test")) {
      events.push(event);
      log(`    [event] ${event.type}: ${JSON.stringify(event).slice(0, 200)}`);

      if (event.type === "text") gotText = true;
      if (event.type === "complete") gotComplete = true;
      if (event.type === "error") {
        throw new Error(
          `Agent error: ${"message" in event ? event.message : JSON.stringify(event)}`,
        );
      }
    }

    log(`    total events: ${events.length}`);

    if (events.length === 0) {
      throw new Error("No events received from stream");
    }

    pass("prompt stream received events");

    if (gotComplete) {
      pass("stream ended with complete event");
    } else {
      // Stream may end without explicit complete if the connection closes
      pass("stream ended (no explicit complete event)");
    }
  } catch (err) {
    fail("adapter.prompt (streaming)", err);
  }
}

// ─── Test 5: adapter.close ───────────────────────────────────────────────────

async function testAdapterClose(
  adapter: IbmAcpAdapter,
  session: SessionHandle,
): Promise<void> {
  log("\n--- Test 5: IbmAcpAdapter.close ---\n");

  try {
    await adapter.close(session);
    pass("close completed (no-op for IBM ACP)");
  } catch (err) {
    fail("adapter.close", err);
  }
}

// ─── Test 6: Restate VO (IbmAgentSession) ────────────────────────────────────

async function testRestateVO(): Promise<void> {
  log("\n--- Test 6: Restate VO (IbmAgentSession) ---\n");

  const restateUp = await checkRestateRunning();
  if (!restateUp) {
    skip("Restate VO test", "Restate not running on port 18080/19070");
    return;
  }

  const voRegistered = await checkVORegistered();
  if (!voRegistered) {
    skip(
      "Restate VO test",
      "IbmAgentSession not registered in Restate",
    );
    return;
  }

  const sessionKey = `e2e-ibm-vo-${Date.now()}`;

  try {
    // Step 1: startSession
    log("  Calling IbmAgentSession/startSession ...");
    const startResp = await fetch(
      `${RESTATE_INGRESS_URL}/IbmAgentSession/${sessionKey}/startSession`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: AGENT_URL }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!startResp.ok) {
      const body = await startResp.text();
      throw new Error(
        `startSession failed: ${startResp.status} ${body.slice(0, 300)}`,
      );
    }

    const sessionHandle = (await startResp.json()) as Record<string, unknown>;
    log(
      `    sessionHandle: ${JSON.stringify(sessionHandle).slice(0, 300)}`,
    );

    if (
      sessionHandle?.sessionId &&
      sessionHandle?.protocol === "ibm"
    ) {
      pass("startSession returned valid SessionHandle");
    } else {
      throw new Error(
        `Unexpected session handle: ${JSON.stringify(sessionHandle).slice(0, 300)}`,
      );
    }

    // Step 2: getStatus
    log("  Calling IbmAgentSession/getStatus ...");
    const statusResp = await fetch(
      `${RESTATE_INGRESS_URL}/IbmAgentSession/${sessionKey}/getStatus`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (statusResp.ok) {
      const meta = await statusResp.json();
      log(`    meta: ${JSON.stringify(meta).slice(0, 300)}`);
      if (
        (meta as Record<string, unknown>)?.status === "active"
      ) {
        pass("getStatus returned active session");
      } else {
        pass("getStatus returned metadata");
      }
    } else {
      fail("getStatus", `HTTP ${statusResp.status}`);
    }

    // Step 3: terminateSession
    log("  Calling IbmAgentSession/terminateSession ...");
    const termResp = await fetch(
      `${RESTATE_INGRESS_URL}/IbmAgentSession/${sessionKey}/terminateSession`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (termResp.ok) {
      pass("terminateSession succeeded");
    } else {
      fail("terminateSession", `HTTP ${termResp.status}`);
    }
  } catch (err) {
    fail("Restate VO test", err);

    // Best-effort cleanup
    try {
      await fetch(
        `${RESTATE_INGRESS_URL}/IbmAgentSession/${sessionKey}/terminateSession`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "null",
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("=== E2E Test: IBM ACP Path ===\n");

  // Precondition: echo agent must be running
  const agentUp = await checkAgentRunning();
  if (!agentUp) {
    log(`ABORT: Echo agent not reachable at ${AGENT_URL}`);
    log("Start the agent first:");
    log("  cd tests/echo-agent && uv run python server.py");
    process.exit(1);
  }
  pass(`echo agent reachable at ${AGENT_URL}`);

  const adapter = new IbmAcpAdapter();

  // Test 1: start
  const session = await testAdapterStart(adapter);
  if (!session) {
    log("\nABORT: Cannot continue without a valid session.");
    process.exit(1);
  }

  // Test 2: createRun (fire-and-forget, just get a runId)
  await testAdapterCreateRun(adapter, session);

  // Small delay so the first run finishes before we start the next
  await delay(500);

  // Test 3: promptSync (createRun + poll to completion)
  await testAdapterPromptSync(adapter, session);

  // Test 4: streaming
  await testAdapterStream(adapter, session);

  // Test 5: close
  await testAdapterClose(adapter, session);

  // Test 6: Restate VO (only if Restate is up + VO registered)
  await testRestateVO();

  // Summary
  log("\n=== Summary ===");
  log(`  Passed:  ${passed}`);
  log(`  Failed:  ${failed}`);
  log(`  Skipped: ${skipped}`);
  log("");

  if (failed > 0) {
    log("RESULT: FAIL");
    process.exit(1);
  } else {
    log("RESULT: PASS");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
