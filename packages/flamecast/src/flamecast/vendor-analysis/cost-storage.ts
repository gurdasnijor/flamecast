import type {
  SessionCostRecord,
  ProviderPricing,
} from "@flamecast/protocol/vendor-analysis";

/**
 * Storage interface for vendor analysis cost tracking.
 *
 * Separated from FlamecastStorage to keep the core storage lean.
 * Implementations can back this with the same DB or a separate one.
 */
export interface CostStorage {
  recordSessionCost(record: SessionCostRecord): Promise<void>;
  getSessionCost(sessionId: string): Promise<SessionCostRecord | null>;
  listSessionCosts(opts?: {
    provider?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<SessionCostRecord[]>;

  setProviderPricing(pricing: ProviderPricing): Promise<void>;
  getProviderPricing(provider: string): Promise<ProviderPricing | null>;
  listProviderPricing(): Promise<ProviderPricing[]>;
}

/** In-memory implementation for dev / testing. */
export class MemoryCostStorage implements CostStorage {
  private records = new Map<string, SessionCostRecord>();
  private pricing = new Map<string, ProviderPricing>();

  async recordSessionCost(record: SessionCostRecord): Promise<void> {
    this.records.set(record.sessionId, { ...record });
  }

  async getSessionCost(sessionId: string): Promise<SessionCostRecord | null> {
    return this.records.get(sessionId) ?? null;
  }

  async listSessionCosts(opts?: {
    provider?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<SessionCostRecord[]> {
    let results = [...this.records.values()];

    if (opts?.provider) {
      results = results.filter((r) => r.provider === opts.provider);
    }
    if (opts?.since) {
      const since = opts.since;
      results = results.filter((r) => r.startedAt >= since);
    }
    if (opts?.until) {
      const until = opts.until;
      results = results.filter((r) => r.startedAt <= until);
    }

    results.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (opts?.limit) {
      results = results.slice(0, opts.limit);
    }

    return results;
  }

  async setProviderPricing(pricing: ProviderPricing): Promise<void> {
    this.pricing.set(pricing.provider, { ...pricing });
  }

  async getProviderPricing(provider: string): Promise<ProviderPricing | null> {
    return this.pricing.get(provider) ?? null;
  }

  async listProviderPricing(): Promise<ProviderPricing[]> {
    return [...this.pricing.values()];
  }
}
