/**
 * A fixed-window, in-memory rate limiter. One query service instance runs in
 * v1, so memory is enough; move to Postgres or Redis if it ever scales out.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one call; returns seconds to wait when over the limit, or 0. */
  hit(key: string, limit: number): number {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 50_000) this.prune(t);
    }
    w.count += 1;
    return w.count > limit ? Math.ceil((w.start + this.windowMs - t) / 1000) : 0;
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
