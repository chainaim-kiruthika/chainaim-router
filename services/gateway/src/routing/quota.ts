/**
 * Free-model quota (spec section 7): at most `rpm` free-model calls in any
 * 60-second window (every attempt counts), the key's daily allowance read
 * from OpenRouter and counted down locally between reads, and pauses after
 * an account-level 429. capacity() is what the paywall asks before it shows
 * a price for chat.
 */
export type Capacity = { chatAvailable: boolean; reason?: "no_models" | "key_rejected" | "daily_exhausted" | "rate_limited"; retryAfterSec?: number };
export type QuotaOptions = { rpm: number; keyIntervalMs: number; keyUrl?: string; apiKey?: string; now?: () => number };

const WINDOW_MS = 60_000;

export class Quota {
  private readonly opts: QuotaOptions;
  private readonly calls: number[] = [];
  private pausedUntil = 0;
  private dailyRemaining: number | undefined;
  private dailyPaused = false;
  private keyRejected = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: QuotaOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Why no free-model call may start now, or undefined when one may. */
  private blocked(now: number): Capacity["reason"] {
    if (this.keyRejected) return "key_rejected";
    if (this.dailyPaused || this.dailyRemaining === 0) return "daily_exhausted";
    while (this.calls.length > 0 && this.calls[0] <= now - WINDOW_MS) this.calls.shift();
    if (this.pausedUntil > now || this.calls.length >= this.opts.rpm) return "rate_limited";
    return undefined;
  }

  /** Count one free-model call; false when the window, the daily allowance or a pause forbids it. */
  take(): boolean {
    const now = this.now();
    if (this.blocked(now)) return false;
    this.calls.push(now);
    if (this.dailyRemaining !== undefined) this.dailyRemaining = Math.max(0, this.dailyRemaining - 1);
    return true;
  }

  capacity(modelsReady: boolean): Capacity {
    if (!modelsReady) return { chatAvailable: false, reason: "no_models" };
    const now = this.now();
    const reason = this.blocked(now);
    if (reason === undefined) return { chatAvailable: true };
    if (reason !== "rate_limited") return { chatAvailable: false, reason };
    const windowFrees = this.calls.length >= this.opts.rpm ? this.calls[this.calls.length - this.opts.rpm] + WINDOW_MS : 0;
    const until = Math.max(this.pausedUntil, windowFrees);
    return { chatAvailable: false, reason, retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)) };
  }

  /** An account-level 429: pause for 60 s (per minute) or until a key read shows allowance (per day). */
  onAccountLimit(scope: "minute" | "day"): void {
    if (scope === "minute") this.pausedUntil = this.now() + WINDOW_MS;
    else {
      this.dailyPaused = true;
      this.dailyRemaining = 0;
    }
    void this.refresh();
  }

  /** OpenRouter rejected the key: unavailable until a key read succeeds, and one starts now. */
  onKeyRejected(): void {
    if (!this.opts.keyUrl) return;
    this.keyRejected = true;
    void this.refresh();
  }

  /** Read the key's free-model allowance (GET /api/v1/key). Failures keep the last known values. */
  async refresh(): Promise<void> {
    if (!this.opts.keyUrl || !this.opts.apiKey) return;
    let res: Response;
    try {
      res = await fetch(this.opts.keyUrl, { headers: { authorization: `Bearer ${this.opts.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    } catch {
      return;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      this.keyRejected = true;
      return;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return;
    }
    this.keyRejected = false;
    const data = (body as { data?: unknown } | null)?.data ?? body;
    const remaining = (data as { free_model_daily_requests?: { remaining?: unknown } } | null)?.free_model_daily_requests?.remaining;
    if (typeof remaining === "number" && Number.isInteger(remaining) && remaining >= 0) {
      this.dailyRemaining = remaining;
      if (remaining > 0) this.dailyPaused = false;
    }
  }

  start(): void {
    if (this.timer || this.opts.keyIntervalMs <= 0 || !this.opts.keyUrl) return;
    this.timer = setInterval(() => void this.refresh(), this.opts.keyIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
