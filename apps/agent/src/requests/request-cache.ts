export type CachedRequestValue<T> = {
  value: T;
  completedAt: number;
};

export class RequestCache<T> {
  private readonly entries = new Map<string, CachedRequestValue<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: {
    maxEntries?: number;
    ttlMs?: number;
    now?: () => number;
  } = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  get(requestId: string): T | undefined {
    this.evictExpired();
    const entry = this.entries.get(requestId);
    if (!entry) return undefined;
    return entry.value;
  }

  set(requestId: string, value: T): void {
    this.evictExpired();
    if (!this.entries.has(requestId) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(requestId);
    this.entries.set(requestId, { value, completedAt: this.now() });
  }

  private evictExpired(): void {
    const threshold = this.now() - this.ttlMs;
    for (const [requestId, entry] of this.entries) {
      if (entry.completedAt <= threshold) this.entries.delete(requestId);
    }
  }
}
