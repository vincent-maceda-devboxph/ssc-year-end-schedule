/** In-memory failure counter for brute-force protection (single server, so memory is enough). */
export class FailureLimiter {
  private readonly entries = new Map<string, { failures: number; blockedUntil: number; firstAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly blockMs: number,
  ) {}

  /** Milliseconds until the key may try again, or 0 if allowed. */
  retryAfter(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (e.blockedUntil > now) return e.blockedUntil - now;
    return 0;
  }

  fail(key: string, now = Date.now()): void {
    const e = this.entries.get(key);
    // Failures older than the block window are forgotten.
    if (!e || now - e.firstAt > this.blockMs) {
      this.entries.set(key, { failures: 1, blockedUntil: 0, firstAt: now });
      return;
    }
    e.failures++;
    if (e.failures >= this.maxFailures) {
      e.blockedUntil = now + this.blockMs;
      e.failures = 0;
      e.firstAt = now;
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  clearAll(): void {
    this.entries.clear();
  }
}
