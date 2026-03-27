import type {
  SessionCostRecord,
  ProviderCostSummary,
  ProviderComparison,
  PortabilityReport,
  PortabilityFactor,
  ProviderPricing,
  VendorAnalysisDashboard,
} from "@flamecast/protocol/vendor-analysis";
import type { CostStorage } from "./cost-storage.js";

export type { CostStorage } from "./cost-storage.js";
export { MemoryCostStorage } from "./cost-storage.js";

/**
 * VendorAnalysisService — the core differentiator.
 *
 * Tracks costs per provider, compares them head-to-head, and computes
 * a portability score. This is what makes "buy the best deal" possible:
 * enterprises can see exactly what each provider costs and switch freely.
 */
export class VendorAnalysisService {
  readonly storage: CostStorage;

  constructor(storage: CostStorage) {
    this.storage = storage;
  }

  // ---------------------------------------------------------------------------
  // Cost recording (called from session lifecycle hooks)
  // ---------------------------------------------------------------------------

  async recordSessionCost(record: SessionCostRecord): Promise<void> {
    await this.storage.recordSessionCost(record);
  }

  async setProviderPricing(pricing: ProviderPricing): Promise<void> {
    await this.storage.setProviderPricing(pricing);
  }

  // ---------------------------------------------------------------------------
  // Analysis queries
  // ---------------------------------------------------------------------------

  async getProviderSummaries(opts?: {
    since?: string;
    until?: string;
  }): Promise<ProviderCostSummary[]> {
    const records = await this.storage.listSessionCosts({
      since: opts?.since,
      until: opts?.until,
    });

    const byProvider = new Map<string, SessionCostRecord[]>();
    for (const record of records) {
      const list = byProvider.get(record.provider) ?? [];
      list.push(record);
      byProvider.set(record.provider, list);
    }

    const summaries: ProviderCostSummary[] = [];
    for (const [provider, providerRecords] of byProvider) {
      summaries.push(this.summarize(provider, providerRecords));
    }

    // Sort by total cost descending (most expensive first)
    summaries.sort((a, b) => b.totalEstimatedCostUsd - a.totalEstimatedCostUsd);
    return summaries;
  }

  async compareProviders(
    providerA: string,
    providerB: string,
    opts?: { since?: string; until?: string },
  ): Promise<ProviderComparison> {
    const [recordsA, recordsB] = await Promise.all([
      this.storage.listSessionCosts({ provider: providerA, ...opts }),
      this.storage.listSessionCosts({ provider: providerB, ...opts }),
    ]);

    const summaryA = this.summarize(providerA, recordsA);
    const summaryB = this.summarize(providerB, recordsB);

    const costRatio =
      summaryB.avgCostPerPrompt > 0
        ? summaryA.avgCostPerPrompt / summaryB.avgCostPerPrompt
        : summaryA.totalSessions > 0
          ? Infinity
          : 1;

    const durationRatio =
      summaryB.avgSessionDurationMs > 0
        ? summaryA.avgSessionDurationMs / summaryB.avgSessionDurationMs
        : 1;

    // Project annual savings: extrapolate current daily rate over 365 days
    const allRecords = [...recordsA, ...recordsB];
    const timeSpanMs = this.getTimeSpanMs(allRecords);
    const daysObserved = Math.max(timeSpanMs / (1000 * 60 * 60 * 24), 1);
    const dailyCostA = summaryA.totalEstimatedCostUsd / daysObserved;
    const dailyCostB = summaryB.totalEstimatedCostUsd / daysObserved;
    const projectedAnnualSavingsUsd = (dailyCostA - dailyCostB) * 365;

    return {
      providers: [providerA, providerB],
      costRatio: round(costRatio, 2),
      durationRatio: round(durationRatio, 2),
      projectedAnnualSavingsUsd: round(projectedAnnualSavingsUsd, 2),
      summaries: [summaryA, summaryB],
    };
  }

  async getPortabilityReport(activeProviders: string[]): Promise<PortabilityReport> {
    const allPricing = await this.storage.listProviderPricing();
    const allRecords = await this.storage.listSessionCosts({});

    const factors: PortabilityFactor[] = [];

    // Factor 1: Provider diversity (are sessions spread across providers?)
    const providerDiversity = this.scoreProviderDiversity(allRecords);
    factors.push({
      name: "Provider Diversity",
      score: providerDiversity,
      weight: 0.3,
      description:
        providerDiversity >= 70
          ? "Sessions well distributed across providers — low single-vendor risk"
          : providerDiversity >= 40
            ? "Moderate provider concentration — consider spreading workloads"
            : "Heavy reliance on a single provider — high lock-in risk",
    });

    // Factor 2: Protocol compliance (ACP = portable, proprietary = locked in)
    // All Flamecast sessions use ACP, so this is always 100
    factors.push({
      name: "Protocol Standardization",
      score: 100,
      weight: 0.25,
      description: "All agents communicate via ACP — fully portable across any ACP-compatible runtime",
    });

    // Factor 3: Pricing transparency (do we have pricing data for all active providers?)
    const pricedProviders = new Set(allPricing.map((p) => p.provider));
    const pricingCoverage =
      activeProviders.length > 0
        ? Math.round(
            (activeProviders.filter((p) => pricedProviders.has(p)).length /
              activeProviders.length) *
              100,
          )
        : 100;
    factors.push({
      name: "Pricing Transparency",
      score: pricingCoverage,
      weight: 0.2,
      description:
        pricingCoverage >= 80
          ? "Pricing configured for most providers — can make informed switching decisions"
          : "Missing pricing data for some providers — configure pricing to enable cost comparison",
    });

    // Factor 4: Runtime abstraction (self-hosted vs vendor-managed)
    const selfHostedScore = activeProviders.length > 0 ? 80 : 50;
    factors.push({
      name: "Runtime Abstraction",
      score: selfHostedScore,
      weight: 0.15,
      description:
        "Self-hosted control plane with pluggable runtimes — no vendor controls your infrastructure",
    });

    // Factor 5: Data sovereignty
    factors.push({
      name: "Data Sovereignty",
      score: 100,
      weight: 0.1,
      description: "All session data stored in your infrastructure — full ownership and compliance control",
    });

    const weightedScore = factors.reduce((sum, f) => sum + f.score * f.weight, 0);
    const score = Math.round(weightedScore);

    const recommendations: string[] = [];
    if (providerDiversity < 50) {
      recommendations.push(
        "Distribute workloads across at least 2 providers to reduce single-vendor dependency",
      );
    }
    if (pricingCoverage < 80) {
      recommendations.push(
        "Configure pricing for all active providers to enable accurate cost comparisons",
      );
    }
    if (allRecords.length < 10) {
      recommendations.push(
        "Run more sessions to build a meaningful cost baseline for comparison",
      );
    }
    if (activeProviders.length === 1) {
      recommendations.push(
        `Currently using only "${activeProviders[0]}" — register additional runtimes to unlock provider switching`,
      );
    }

    return {
      score,
      factors,
      recommendations,
      generatedAt: new Date().toISOString(),
    };
  }

  async getDashboard(
    activeProviders: string[],
    opts?: { since?: string; until?: string },
  ): Promise<VendorAnalysisDashboard> {
    const [summaries, portability] = await Promise.all([
      this.getProviderSummaries(opts),
      this.getPortabilityReport(activeProviders),
    ]);

    // Find the best deal (lowest cost per prompt with at least 1 session)
    const viable = summaries.filter((s) => s.totalSessions > 0 && s.avgCostPerPrompt > 0);
    const bestDeal = viable.length > 0
      ? viable.reduce((best, s) =>
          s.avgCostPerPrompt < best.avgCostPerPrompt ? s : best,
        )
      : null;

    const now = new Date().toISOString();
    return {
      providerSummaries: summaries,
      portability,
      bestDeal: bestDeal
        ? {
            provider: bestDeal.provider,
            reason: `Lowest cost per prompt at $${bestDeal.avgCostPerPrompt.toFixed(4)}/prompt`,
            avgCostPerPrompt: bestDeal.avgCostPerPrompt,
          }
        : null,
      timeRange: {
        from: opts?.since ?? "all-time",
        to: opts?.until ?? now,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Estimation — predict cost for a session before it runs
  // ---------------------------------------------------------------------------

  async estimateSessionCost(
    provider: string,
    estimatedDurationMs: number,
    estimatedPromptCount: number,
  ): Promise<{ estimatedCostUsd: number; breakdown: { compute: number; prompts: number } }> {
    const pricing = await this.storage.getProviderPricing(provider);
    if (!pricing) {
      // Fall back to historical average
      const records = await this.storage.listSessionCosts({ provider });
      if (records.length === 0) {
        return { estimatedCostUsd: 0, breakdown: { compute: 0, prompts: 0 } };
      }
      const summary = this.summarize(provider, records);
      const estimatedCostUsd = summary.avgCostPerPrompt * estimatedPromptCount;
      return {
        estimatedCostUsd: round(estimatedCostUsd, 4),
        breakdown: { compute: 0, prompts: round(estimatedCostUsd, 4) },
      };
    }

    const hours = estimatedDurationMs / (1000 * 60 * 60);
    const compute = hours * pricing.computePerHourUsd;
    const prompts = (estimatedPromptCount / 1000) * pricing.perKPromptUsd;
    const estimatedCostUsd = compute + prompts + (pricing.monthlyBaseUsd ?? 0) / 30 / 24 * hours;

    return {
      estimatedCostUsd: round(estimatedCostUsd, 4),
      breakdown: {
        compute: round(compute, 4),
        prompts: round(prompts, 4),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private summarize(provider: string, records: SessionCostRecord[]): ProviderCostSummary {
    if (records.length === 0) {
      return {
        provider,
        totalSessions: 0,
        totalDurationMs: 0,
        totalEstimatedCostUsd: 0,
        totalPrompts: 0,
        avgCostPerSession: 0,
        avgCostPerPrompt: 0,
        avgSessionDurationMs: 0,
      };
    }

    const totalSessions = records.length;
    const totalDurationMs = records.reduce((sum, r) => sum + r.durationMs, 0);
    const totalEstimatedCostUsd = records.reduce((sum, r) => sum + r.estimatedCostUsd, 0);
    const totalPrompts = records.reduce((sum, r) => sum + r.promptCount, 0);

    return {
      provider,
      totalSessions,
      totalDurationMs,
      totalEstimatedCostUsd: round(totalEstimatedCostUsd, 4),
      totalPrompts,
      avgCostPerSession: round(totalEstimatedCostUsd / totalSessions, 4),
      avgCostPerPrompt: totalPrompts > 0 ? round(totalEstimatedCostUsd / totalPrompts, 4) : 0,
      avgSessionDurationMs: Math.round(totalDurationMs / totalSessions),
    };
  }

  private scoreProviderDiversity(records: SessionCostRecord[]): number {
    if (records.length === 0) return 50; // No data = neutral

    const byProvider = new Map<string, number>();
    for (const r of records) {
      byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1);
    }

    const providerCount = byProvider.size;
    if (providerCount <= 1) return 20; // Single provider = high lock-in risk

    // Shannon entropy normalized to 0-100
    const total = records.length;
    let entropy = 0;
    for (const count of byProvider.values()) {
      const p = count / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(providerCount);
    const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

    // Scale: 20 (single vendor) to 100 (perfectly distributed)
    return Math.round(20 + normalizedEntropy * 80);
  }

  private getTimeSpanMs(records: SessionCostRecord[]): number {
    if (records.length === 0) return 0;
    const timestamps = records.map((r) => new Date(r.startedAt).getTime());
    return Math.max(...timestamps) - Math.min(...timestamps);
  }
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
