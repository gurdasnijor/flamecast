import { Hono } from "hono";
import type { VendorAnalysisService } from "./index.js";
import type { ProviderPricing } from "@flamecast/protocol/vendor-analysis";

export type VendorAnalysisApi = {
  vendorAnalysis: VendorAnalysisService;
  runtimeNames: string[];
};

/**
 * Vendor analysis API routes.
 *
 * Mounted at /api/vendor-analysis — gives enterprises visibility into
 * provider costs, comparisons, and portability scores.
 */
export function createVendorAnalysisApi(ctx: VendorAnalysisApi) {
  return new Hono()
    // ---- Dashboard: one-stop overview ----
    .get("/dashboard", async (c) => {
      try {
        const since = c.req.query("since") ?? undefined;
        const until = c.req.query("until") ?? undefined;
        const dashboard = await ctx.vendorAnalysis.getDashboard(ctx.runtimeNames, {
          since,
          until,
        });
        return c.json(dashboard);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    })

    // ---- Provider cost summaries ----
    .get("/costs", async (c) => {
      try {
        const since = c.req.query("since") ?? undefined;
        const until = c.req.query("until") ?? undefined;
        const summaries = await ctx.vendorAnalysis.getProviderSummaries({ since, until });
        return c.json(summaries);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    })

    // ---- Head-to-head provider comparison ----
    .get("/compare/:providerA/:providerB", async (c) => {
      try {
        const providerA = c.req.param("providerA");
        const providerB = c.req.param("providerB");
        const since = c.req.query("since") ?? undefined;
        const until = c.req.query("until") ?? undefined;
        const comparison = await ctx.vendorAnalysis.compareProviders(providerA, providerB, {
          since,
          until,
        });
        return c.json(comparison);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    })

    // ---- Portability report ----
    .get("/portability", async (c) => {
      try {
        const report = await ctx.vendorAnalysis.getPortabilityReport(ctx.runtimeNames);
        return c.json(report);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    })

    // ---- Cost estimation ----
    .get("/estimate/:provider", async (c) => {
      try {
        const provider = c.req.param("provider");
        const durationMs = parseInt(c.req.query("durationMs") ?? "3600000", 10);
        const promptCount = parseInt(c.req.query("promptCount") ?? "10", 10);
        const estimate = await ctx.vendorAnalysis.estimateSessionCost(
          provider,
          durationMs,
          promptCount,
        );
        return c.json(estimate);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    })

    // ---- Provider pricing CRUD ----
    .get("/pricing", async (c) => {
      try {
        const pricing = await ctx.vendorAnalysis.storage.listProviderPricing();
        return c.json(pricing);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    })
    .put("/pricing/:provider", async (c) => {
      try {
        const provider = c.req.param("provider");
        const body = await c.req.json<Omit<ProviderPricing, "provider">>();
        if (typeof body.computePerHourUsd !== "number" || typeof body.perKPromptUsd !== "number") {
          return c.json(
            { error: "Required: computePerHourUsd (number), perKPromptUsd (number)" },
            400,
          );
        }
        const pricing: ProviderPricing = { provider, ...body };
        await ctx.vendorAnalysis.setProviderPricing(pricing);
        return c.json(pricing);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    })

    // ---- Session cost records ----
    .get("/sessions", async (c) => {
      try {
        const provider = c.req.query("provider") ?? undefined;
        const since = c.req.query("since") ?? undefined;
        const until = c.req.query("until") ?? undefined;
        const limitParam = c.req.query("limit");
        const limit = limitParam ? parseInt(limitParam, 10) : 100;
        const records = await ctx.vendorAnalysis.storage.listSessionCosts({
          provider,
          since,
          until,
          limit,
        });
        return c.json(records);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
