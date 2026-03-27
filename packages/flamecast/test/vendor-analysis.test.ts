import { describe, it, expect, beforeEach } from "vitest";
import { VendorAnalysisService, MemoryCostStorage } from "../src/flamecast/vendor-analysis/index.js";
import type { SessionCostRecord } from "@flamecast/protocol/vendor-analysis";

function makeRecord(overrides: Partial<SessionCostRecord> = {}): SessionCostRecord {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    provider: "local",
    agentName: "test-agent",
    startedAt: "2026-03-27T00:00:00.000Z",
    endedAt: "2026-03-27T01:00:00.000Z",
    durationMs: 3600000,
    estimatedCostUsd: 0.5,
    promptCount: 10,
    metadata: {},
    ...overrides,
  };
}

describe("VendorAnalysisService", () => {
  let service: VendorAnalysisService;

  beforeEach(() => {
    service = new VendorAnalysisService(new MemoryCostStorage());
  });

  describe("cost recording and summaries", () => {
    it("returns empty summaries with no data", async () => {
      const summaries = await service.getProviderSummaries();
      expect(summaries).toEqual([]);
    });

    it("summarizes costs by provider", async () => {
      await service.recordSessionCost(
        makeRecord({ provider: "docker", estimatedCostUsd: 1.0, promptCount: 20 }),
      );
      await service.recordSessionCost(
        makeRecord({ provider: "docker", estimatedCostUsd: 0.5, promptCount: 10 }),
      );
      await service.recordSessionCost(
        makeRecord({ provider: "e2b", estimatedCostUsd: 0.3, promptCount: 15 }),
      );

      const summaries = await service.getProviderSummaries();
      expect(summaries).toHaveLength(2);

      // oxlint-disable-next-line no-type-assertion/no-type-assertion -- test assertion
      const docker = summaries.find((s) => s.provider === "docker") as (typeof summaries)[0];
      expect(docker.totalSessions).toBe(2);
      expect(docker.totalEstimatedCostUsd).toBe(1.5);
      expect(docker.totalPrompts).toBe(30);
      expect(docker.avgCostPerSession).toBe(0.75);
      expect(docker.avgCostPerPrompt).toBe(0.05);

      // oxlint-disable-next-line no-type-assertion/no-type-assertion -- test assertion
      const e2b = summaries.find((s) => s.provider === "e2b") as (typeof summaries)[0];
      expect(e2b.totalSessions).toBe(1);
      expect(e2b.totalEstimatedCostUsd).toBe(0.3);
    });

    it("sorts summaries by total cost descending", async () => {
      await service.recordSessionCost(makeRecord({ provider: "cheap", estimatedCostUsd: 0.1 }));
      await service.recordSessionCost(
        makeRecord({ provider: "expensive", estimatedCostUsd: 10.0 }),
      );

      const summaries = await service.getProviderSummaries();
      expect(summaries[0]).toBeDefined();
      expect(summaries[0]?.provider).toBe("expensive");
      expect(summaries[1]).toBeDefined();
      expect(summaries[1]?.provider).toBe("cheap");
    });
  });

  describe("provider comparison", () => {
    it("compares two providers head-to-head", async () => {
      // Provider A: expensive
      for (let i = 0; i < 5; i++) {
        await service.recordSessionCost(
          makeRecord({
            provider: "cloud-a",
            estimatedCostUsd: 2.0,
            promptCount: 10,
            durationMs: 3600000,
            startedAt: `2026-03-${20 + i}T00:00:00.000Z`,
          }),
        );
      }

      // Provider B: cheap
      for (let i = 0; i < 5; i++) {
        await service.recordSessionCost(
          makeRecord({
            provider: "cloud-b",
            estimatedCostUsd: 0.5,
            promptCount: 10,
            durationMs: 3600000,
            startedAt: `2026-03-${20 + i}T00:00:00.000Z`,
          }),
        );
      }

      const comparison = await service.compareProviders("cloud-a", "cloud-b");
      expect(comparison.providers).toEqual(["cloud-a", "cloud-b"]);
      expect(comparison.costRatio).toBe(4); // A is 4x more expensive
      expect(comparison.projectedAnnualSavingsUsd).toBeGreaterThan(0);
      expect(comparison.summaries[0]?.provider).toBe("cloud-a");
      expect(comparison.summaries[1]?.provider).toBe("cloud-b");
    });

    it("handles comparison with empty provider gracefully", async () => {
      await service.recordSessionCost(makeRecord({ provider: "has-data" }));
      const comparison = await service.compareProviders("has-data", "no-data");
      expect(comparison.summaries[1]?.totalSessions).toBe(0);
    });
  });

  describe("portability report", () => {
    it("returns a valid report with no data", async () => {
      const report = await service.getPortabilityReport(["local"]);
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(100);
      expect(report.factors.length).toBeGreaterThan(0);
      expect(report.generatedAt).toBeTruthy();
    });

    it("penalizes single-provider deployments", async () => {
      await service.recordSessionCost(makeRecord({ provider: "only-one" }));
      const report = await service.getPortabilityReport(["only-one"]);

      // oxlint-disable-next-line no-type-assertion/no-type-assertion -- test assertion
      const diversity = report.factors.find((f) => f.name === "Provider Diversity") as (typeof report.factors)[0];
      expect(diversity.score).toBeLessThanOrEqual(30);

      expect(report.recommendations.some((r) => r.includes("additional runtimes"))).toBe(true);
    });

    it("rewards multi-provider usage", async () => {
      for (const provider of ["docker", "e2b", "local"]) {
        for (let i = 0; i < 5; i++) {
          await service.recordSessionCost(makeRecord({ provider }));
        }
      }

      const report = await service.getPortabilityReport(["docker", "e2b", "local"]);
      // oxlint-disable-next-line no-type-assertion/no-type-assertion -- test assertion
      const diversity = report.factors.find((f) => f.name === "Provider Diversity") as (typeof report.factors)[0];
      expect(diversity.score).toBeGreaterThanOrEqual(80);
    });

    it("always scores 100 on protocol standardization (ACP)", async () => {
      const report = await service.getPortabilityReport(["local"]);
      // oxlint-disable-next-line no-type-assertion/no-type-assertion -- test assertion
      const protocol = report.factors.find((f) => f.name === "Protocol Standardization") as (typeof report.factors)[0];
      expect(protocol.score).toBe(100);
    });
  });

  describe("cost estimation", () => {
    it("estimates cost from provider pricing", async () => {
      await service.setProviderPricing({
        provider: "docker",
        computePerHourUsd: 0.10,
        perKPromptUsd: 5.0,
      });

      const estimate = await service.estimateSessionCost("docker", 3600000, 100);
      expect(estimate.estimatedCostUsd).toBeGreaterThan(0);
      expect(estimate.breakdown.compute).toBe(0.1); // 1 hour * $0.10/hr
      expect(estimate.breakdown.prompts).toBe(0.5); // 100/1000 * $5.0
    });

    it("falls back to historical average without pricing", async () => {
      await service.recordSessionCost(
        makeRecord({ provider: "custom", estimatedCostUsd: 1.0, promptCount: 10 }),
      );

      const estimate = await service.estimateSessionCost("custom", 3600000, 20);
      expect(estimate.estimatedCostUsd).toBe(2.0); // $0.10/prompt * 20 prompts
    });

    it("returns zero for unknown provider with no data", async () => {
      const estimate = await service.estimateSessionCost("unknown", 3600000, 10);
      expect(estimate.estimatedCostUsd).toBe(0);
    });
  });

  describe("dashboard", () => {
    it("returns a complete dashboard", async () => {
      await service.recordSessionCost(
        makeRecord({ provider: "docker", estimatedCostUsd: 1.0, promptCount: 10 }),
      );
      await service.recordSessionCost(
        makeRecord({ provider: "e2b", estimatedCostUsd: 0.3, promptCount: 10 }),
      );

      const dashboard = await service.getDashboard(["docker", "e2b"]);
      expect(dashboard.providerSummaries).toHaveLength(2);
      expect(dashboard.portability.score).toBeGreaterThan(0);
      expect(dashboard.bestDeal).not.toBeNull();
      expect(dashboard.bestDeal?.provider).toBe("e2b"); // Cheaper per prompt
      expect(dashboard.timeRange).toBeDefined();
    });

    it("returns null bestDeal with no data", async () => {
      const dashboard = await service.getDashboard(["local"]);
      expect(dashboard.bestDeal).toBeNull();
    });
  });
});
