// ---------------------------------------------------------------------------
// Vendor lock-in analysis types
//
// These types power Flamecast's differentiation: enterprises can compare
// providers side-by-side and switch to the best deal without lock-in.
// ---------------------------------------------------------------------------

/** Cost record for a single session, tracked per provider. */
export interface SessionCostRecord {
  sessionId: string;
  provider: string;
  agentName: string;
  /** ISO timestamp when the session started. */
  startedAt: string;
  /** ISO timestamp when the session ended (null if still active). */
  endedAt: string | null;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Estimated cost in USD (compute + API calls). */
  estimatedCostUsd: number;
  /** Number of prompts processed. */
  promptCount: number;
  /** Arbitrary provider-specific metadata (tokens used, container specs, etc). */
  metadata: Record<string, unknown>;
}

/** Aggregated cost summary for a single provider. */
export interface ProviderCostSummary {
  provider: string;
  totalSessions: number;
  totalDurationMs: number;
  totalEstimatedCostUsd: number;
  totalPrompts: number;
  avgCostPerSession: number;
  avgCostPerPrompt: number;
  avgSessionDurationMs: number;
}

/** Head-to-head comparison between two providers. */
export interface ProviderComparison {
  providers: [string, string];
  /** Cost ratio: provider[0] cost / provider[1] cost. >1 means provider[0] is more expensive. */
  costRatio: number;
  /** Duration ratio: provider[0] avg duration / provider[1] avg duration. */
  durationRatio: number;
  /** Estimated annual savings by switching from provider[0] to provider[1] (negative = loss). */
  projectedAnnualSavingsUsd: number;
  summaries: [ProviderCostSummary, ProviderCostSummary];
}

/** Portability score for the overall deployment. */
export interface PortabilityReport {
  /** 0-100. Higher = more portable, less locked in. */
  score: number;
  /** Breakdown of factors contributing to the score. */
  factors: PortabilityFactor[];
  /** Actionable recommendations to reduce lock-in. */
  recommendations: string[];
  generatedAt: string;
}

export interface PortabilityFactor {
  name: string;
  /** 0-100 sub-score for this factor. */
  score: number;
  weight: number;
  description: string;
}

/** Provider pricing configuration. */
export interface ProviderPricing {
  provider: string;
  /** Cost per hour of compute in USD. */
  computePerHourUsd: number;
  /** Cost per 1K prompts in USD (API/token costs). */
  perKPromptUsd: number;
  /** Optional flat monthly fee. */
  monthlyBaseUsd?: number;
}

/** Overall vendor analysis dashboard response. */
export interface VendorAnalysisDashboard {
  providerSummaries: ProviderCostSummary[];
  portability: PortabilityReport;
  /** Top recommendation: which provider is the current "best deal". */
  bestDeal: {
    provider: string;
    reason: string;
    avgCostPerPrompt: number;
  } | null;
  /** Time range of the analysis. */
  timeRange: {
    from: string;
    to: string;
  };
}
