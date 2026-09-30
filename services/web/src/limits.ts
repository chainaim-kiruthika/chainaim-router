/**
 * In-memory limits for the demo page: executes per visitor per minute, and
 * executes across all visitors per hour. The hourly cap bounds what the demo
 * buyer wallet can spend. Both reset when the process restarts.
 */
export type LimitReason = "visitor" | "hour";

const MINUTE = 60_000;
const HOUR = 3_600_000;

export class Limits {
  private readonly visitors = new Map<string, number[]>();
  private hour: number[] = [];
  private readonly perMinute: number;
  private readonly perHour: number;
  private readonly now: () => number;

  constructor(perMinute: number, perHour: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.perHour = perHour;
    this.now = now;
  }

  /** undefined when the execute is allowed (and recorded); otherwise which limit was hit. */
  take(visitor: string): LimitReason | undefined {
    const t = this.now();
    this.hour = this.hour.filter((at) => t - at < HOUR);
    const mine = (this.visitors.get(visitor) ?? []).filter((at) => t - at < MINUTE);
    if (mine.length >= this.perMinute) {
      this.visitors.set(visitor, mine);
      return "visitor";
    }
    if (this.hour.length >= this.perHour) {
      this.visitors.set(visitor, mine);
      return "hour";
    }
    mine.push(t);
    this.visitors.set(visitor, mine);
    this.hour.push(t);
    if (this.visitors.size > 10_000) {
      for (const [key, times] of this.visitors) if (times.every((at) => t - at >= MINUTE)) this.visitors.delete(key);
    }
    return undefined;
  }
}
