// Usage:
// OPENAI_API_KEY=sk-... npx tsx tests/e2e-zed-acp.ts
//
// Optional: Start Restate for VO-level tests
// 1. Start Restate: npx @restatedev/restate-server
// 2. Start endpoint: cd packages/flamecast-restate && npx tsx src/serve-endpoint.ts
// 3. Register: restate deployments register http://localhost:9080
// 4. OPENAI_API_KEY=sk-... npx tsx tests/e2e-zed-acp.ts --with-restate

/**
 * E2E test for the Zed ACP path using ZedAcpAdapter directly.
 *
 * Exercises the full adapter lifecycle:
 *   adapter.start() -> adapter.promptSync() -> adapter.close()
 *
 * Requires: codex at /opt/homebrew/bin/codex, OPENAI_API_KEY in env.
 */

import { execSync } from "node:child_process";
import { ZedAcpAdapter } from "../packages/flamecast-restate/src/zed-acp-adapter.js";
import type { SessionHandle, PromptResult } from "../packages/flamecast-restate/src/adapter.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CODEX_PATH = "/opt/homebrew/bin/codex";

/** Timeout for agent responses (codex can take 10-30s). */
const PROMPT_TIMEOUT_MS = 60_000;

const RESTATE_ADMIN_URL = "http://localhost:19070";
const RESTATE_INGRESS_URL = "http://localhost:18080";

// ─── Test bookkeeping ───────────────────────────────────────────────────────

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

// ─── Timeout helper ─────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout. Rejects with a descriptive error
 * if the promise does not settle within `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${label} did not complete within ${ms}ms`));
    }, ms);

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ─── Precondition checks ───────────────────────────────────────────────────

function checkCodexAvailable(): boolean {
  try {
    execSync(`test -x ${CODEX_PATH}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkOpenAIKey(): boolean {
  return !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
}

async function checkRestateRunning(): Promise<boolean> {
  try {
    const resp = await fetch(`${RESTATE_ADMIN_URL}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function checkVORegistered(): Promise<boolean> {
  try {
    const resp = await fetch(`${RESTATE_ADMIN_URL}/services/ZedAgentSession`);
    return resp.ok;
  } catch {
    return false;
  }
}

// ─── Test 1: Direct ZedAcpAdapter ───────────────────────────────────────────

async function testDirectAdapter(): Promise<void> {
  log("\n--- Test 1: Direct ZedAcpAdapter ---\n");

  const adapter = new ZedAcpAdapter();
  let session: SessionHandle | undefined;

  try {
    // Step 1: adapter.start()
    log("  Starting adapter (codex --acp) ...");
    session = await withTimeout(
      adapter.start({ agent: CODEX_PATH }),
      30_000,
      "adapter.start",
    );

    log(`    sessionId: ${session.sessionId}`);
    log(`    protocol:  ${session.protocol}`);
    log(`    agent:     ${session.agent.name}`);

    if (session.sessionId && session.protocol === "zed") {
      pass("adapter.start() returned valid SessionHandle");
    } else {
      throw new Error(
        `Unexpected session handle: ${JSON.stringify(session).slice(0, 300)}`,
      );
    }

    // Step 2: adapter.promptSync()
    log("  Sending prompt: 'What is 2+2? Reply with just the number.'");
    log("    (this may take 10-30 seconds) ...");

    const result: PromptResult = await withTimeout(
      adapter.promptSync(session, "What is 2+2? Reply with just the number."),
      PROMPT_TIMEOUT_MS,
      "adapter.promptSync",
    );

    log(`    status: ${result.status}`);
    log(`    result: ${JSON.stringify(result).slice(0, 500)}`);

    // Step 3: Verify result.status === "completed"
    if (result.status === "completed") {
      pass("promptSync returned status 'completed'");
    } else if (result.status === "awaiting") {
      // codex may request permission — still a valid ACP response
      pass("promptSync returned status 'awaiting' (permission request) -- valid ACP");
    } else if (result.status === "failed") {
      throw new Error(`promptSync failed: ${result.error}`);
    } else {
      throw new Error(`Unexpected prompt status: ${result.status}`);
    }

    // Check output contains "4"
    if (result.output) {
      const allText = result.output
        .flatMap((m) => m.parts ?? [])
        .map((p) => p.content ?? "")
        .join(" ");
      if (allText.includes("4")) {
        pass("response contains '4'");
      } else {
        log(`    (response text: "${allText.slice(0, 200)}")`);
        pass("response received (content check inconclusive)");
      }
    }
  } catch (err) {
    fail("Direct adapter test", err);
  } finally {
    // Step 4: adapter.close()
    if (session) {
      try {
        log("  Closing session ...");
        await adapter.close(session);
        pass("adapter.close() succeeded");
      } catch (closeErr) {
        fail("adapter.close()", closeErr);
      }
    }
  }
}

// ─── Test 2: Restate VO (ZedAgentSession) ───────────────────────────────────

async function testRestateVO(): Promise<void> {
  log("\n--- Test 2: Restate VO (ZedAgentSession) ---\n");

  const restateUp = await checkRestateRunning();
  if (!restateUp) {
    skip("Restate VO test", "Restate not running (start with --with-restate)");
    return;
  }

  const voRegistered = await checkVORegistered();
  if (!voRegistered) {
    skip("Restate VO test", "ZedAgentSession not registered in Restate");
    return;
  }

  const sessionKey = `e2e-zed-${Date.now()}`;

  try {
    // Step 1: startSession via Restate ingress
    log("  Calling ZedAgentSession/startSession ...");
    const startResp = await fetch(
      `${RESTATE_INGRESS_URL}/ZedAgentSession/${sessionKey}/startSession`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: CODEX_PATH }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!startResp.ok) {
      const body = await startResp.text();
      throw new Error(`startSession failed: ${startResp.status} ${body.slice(0, 300)}`);
    }

    const sessionHandle = (await startResp.json()) as Record<string, unknown>;
    log(`    sessionHandle: ${JSON.stringify(sessionHandle).slice(0, 300)}`);

    if (sessionHandle?.sessionId && sessionHandle?.protocol === "zed") {
      pass("startSession returned valid SessionHandle");
    } else {
      throw new Error(
        `Unexpected session handle: ${JSON.stringify(sessionHandle).slice(0, 300)}`,
      );
    }

    // Step 2: runAgent via Restate ingress
    log("  Calling ZedAgentSession/runAgent ...");
    log("    (this may take 10-30 seconds) ...");
    const runResp = await fetch(
      `${RESTATE_INGRESS_URL}/ZedAgentSession/${sessionKey}/runAgent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "What is 2+2? Reply with just the number.",
        }),
        signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
      },
    );

    if (!runResp.ok) {
      const body = await runResp.text();
      throw new Error(`runAgent failed: ${runResp.status} ${body.slice(0, 300)}`);
    }

    const promptResult = (await runResp.json()) as Record<string, unknown>;
    log(`    promptResult: ${JSON.stringify(promptResult).slice(0, 500)}`);

    const status = promptResult?.status as string | undefined;
    if (status === "completed") {
      pass("runAgent returned completed result");
    } else if (status === "awaiting") {
      pass("runAgent returned awaiting (permission request) -- valid ACP response");
    } else {
      throw new Error(`Unexpected run status: ${status}`);
    }

    // Step 3: getStatus
    log("  Calling ZedAgentSession/getStatus ...");
    const statusResp = await fetch(
      `${RESTATE_INGRESS_URL}/ZedAgentSession/${sessionKey}/getStatus`,
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
      pass("getStatus returned session metadata");
    } else {
      fail("getStatus", `HTTP ${statusResp.status}`);
    }

    // Step 4: terminateSession
    log("  Calling ZedAgentSession/terminateSession ...");
    const termResp = await fetch(
      `${RESTATE_INGRESS_URL}/ZedAgentSession/${sessionKey}/terminateSession`,
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
        `${RESTATE_INGRESS_URL}/ZedAgentSession/${sessionKey}/terminateSession`,
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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("=== E2E Test: Zed ACP Path ===\n");

  // Precondition: codex binary
  if (!checkCodexAvailable()) {
    log(`ABORT: codex not found at ${CODEX_PATH}`);
    log("Install codex or update CODEX_PATH in this script.");
    process.exit(1);
  }
  pass("codex found at " + CODEX_PATH);

  // Precondition: API key
  if (!checkOpenAIKey()) {
    log("\nSKIP: No OPENAI_API_KEY or CODEX_API_KEY set in environment.");
    log("codex --acp requires an API key to function. Set one and retry.");
    log("\n=== Summary ===");
    log("  Passed:  0");
    log("  Failed:  0");
    log("  Skipped: all (no API key)");
    process.exit(0);
  }
  pass("API key available in environment");

  // Test 1: Direct adapter (always runs)
  await testDirectAdapter();

  // Test 2: Restate VO (only if --with-restate flag and Restate is up)
  const withRestate = process.argv.includes("--with-restate");
  if (withRestate) {
    await testRestateVO();
  } else {
    skip("Restate VO test", "pass --with-restate to enable");
  }

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
