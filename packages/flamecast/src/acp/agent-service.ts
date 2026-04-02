/**
 * Durable ACP Agent Service — Restate service wrapping the ACP Gateway.
 *
 * Every agent call is journaled via ctx.run(). Permission requests
 * suspend on Restate awakeables. Crash recovery replays from journal —
 * agents are never re-invoked for completed steps.
 *
 * Usage in a Restate handler:
 *
 *   const pro = await ctx.serviceClient(acpAgents).prompt({
 *     agent: "claude-acp",
 *     messages: [{ role: "user", parts: [{ content_type: "text/plain", content: "..." }] }],
 *   });
 *
 * For multi-agent orchestration:
 *
 *   // Each step journaled independently — crash between = no re-execution
 *   const research = await ctx.serviceClient(acpAgents).prompt({
 *     agent: "claude-acp", messages: researchPrompt
 *   });
 *   const synthesis = await ctx.serviceClient(acpAgents).prompt({
 *     agent: "codex-acp", messages: synthesisPrompt(research)
 *   });
 */

import * as restate from "@restatedev/restate-sdk";
import {
  GatewayClient,
  textMessage,
  extractText,
  type RunResult,
  type Message,
} from "@flamecast/acp-gateway/client";

// ─── Configuration ──────────────────────────────────────────────────────────

const GATEWAY_URL =
  process.env.ACP_GATEWAY_URL ?? "http://localhost:4000";

const gateway = new GatewayClient(GATEWAY_URL);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PromptInput {
  agent: string;
  messages: Message[];
}

export interface PromptTextInput {
  agent: string;
  text: string;
}

export interface PromptOutput {
  status: string;
  output: Message[];
  text: string;
  runId: string;
}

export interface ParallelInput {
  prompts: Array<{ agent: string; messages: Message[] }>;
}

export interface ParallelOutput {
  results: PromptOutput[];
  failures: Array<{ agent: string; error: string }>;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/**
 * Run a single agent — journaled, with durable permission handling.
 *
 * The gateway call is wrapped in ctx.run() so the response is journaled.
 * If the run enters "awaiting" (permission request), we create a Restate
 * awakeable and suspend — zero compute until the permission is resolved
 * externally.
 */
async function prompt(
  ctx: restate.Context,
  input: PromptInput,
): Promise<PromptOutput> {
  // Start async run so we can handle awaiting state
  const created = await ctx.run(`${input.agent}:create`, () =>
    gateway.runAsync(input.agent, input.messages),
  );

  const runId = created.id;

  // Poll until terminal state, handling permissions via awakeables
  let result: RunResult;

  while (true) {
    result = await ctx.run(`${input.agent}:poll`, () =>
      gateway.waitForRun(runId, { pollIntervalMs: 1000, timeoutMs: 300_000 }),
    );

    if (result.status === "awaiting" && result.awaitRequest) {
      // Durable permission handling — suspend on awakeable
      const permission = ctx.awakeable<{ optionId: string }>();

      // Publish the permission request so external systems can resolve it
      await ctx.run(`${input.agent}:permission-request`, () => {
        console.log(
          `[${input.agent}:${runId}] Permission requested:`,
          JSON.stringify(result.awaitRequest),
          `\n  Resolve via: POST /restate/awakeables/${permission.id}/resolve`,
        );
        return { awakeableId: permission.id, request: result.awaitRequest };
      });

      // Suspend — zero compute until permission resolved
      const decision = await permission.promise;

      // Resume the gateway run with the permission decision
      await ctx.run(`${input.agent}:resume`, () =>
        gateway.resumeRun(runId, decision.optionId),
      );

      // Continue polling
      continue;
    }

    // Terminal state
    break;
  }

  const output = result.output ?? [];
  return {
    status: result.status,
    output,
    text: extractText(output),
    runId,
  };
}

/** Convenience: prompt with plain text. */
async function promptText(
  ctx: restate.Context,
  input: PromptTextInput,
): Promise<PromptOutput> {
  return prompt(ctx, {
    agent: input.agent,
    messages: [textMessage("user", input.text)] as unknown as Message[],
  });
}

/**
 * Fan-out: run multiple agents in parallel, each journaled independently.
 *
 * If agent 2 fails, agent 1's result is already in the journal.
 * Retry only re-executes the failed agent.
 */
async function parallel(
  ctx: restate.Context,
  input: ParallelInput,
): Promise<ParallelOutput> {
  const results: PromptOutput[] = [];
  const failures: Array<{ agent: string; error: string }> = [];

  // Each agent call is its own ctx.run — journaled independently
  const promises = input.prompts.map(async (p, i) => {
    try {
      const result = await ctx.run(`parallel:${i}:${p.agent}`, () =>
        gateway.runSync(p.agent, p.messages),
      );
      const output = result.output ?? [];
      results.push({
        status: result.status,
        output,
        text: extractText(output),
        runId: result.id,
      });
    } catch (err) {
      failures.push({
        agent: p.agent,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await Promise.all(promises);
  return { results, failures };
}

/** List available agents from the gateway. */
async function listAgents(ctx: restate.Context): Promise<unknown[]> {
  return ctx.run("list-agents", () => gateway.agents());
}

// ─── Service Definition ─────────────────────────────────────────────────────

export const acpAgents = restate.service({
  name: "AcpAgents",
  handlers: {
    prompt,
    promptText,
    parallel,
    listAgents,
  },
});
