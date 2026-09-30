/**
 * Replay guard. A payment that is verified but never settled (the middleware
 * settles only responses below 400, so every refusal is free) leaves nothing
 * on the chain that stops the caller presenting the same signed transactions
 * again. Each presentation of a refused chat call still costs one request of
 * the free-model quota, so the same signature is accepted once.
 */
import { createHash } from "node:crypto";

/** A signed Algorand transaction is never valid for more than 1,000 rounds (about 47 minutes). */
export const REPLAY_WINDOW_MS = 60 * 60 * 1000;
/** About 5 MB of memory: 32-byte hashes in a Map. */
export const MAX_REPLAY_ENTRIES = 50_000;

export class ReplayGuard {
  private readonly seen = new Map<string, number>(); // key -> expiry; insertion order is time order
  private readonly now: () => number;
  private readonly max: number;

  constructor(now: () => number = Date.now, max: number = MAX_REPLAY_ENTRIES) {
    this.now = now;
    this.max = max;
  }

  /** True the first time a key is seen inside the window (and remembers it); false for a replay. */
  claim(key: string): boolean {
    const t = this.now();
    for (const [k, expiry] of this.seen) {
      if (expiry > t) break;
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, t + REPLAY_WINDOW_MS);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}

/**
 * Identity of a payment: a hash of the signed transactions it carries, decoded
 * from base64 so that another alphabet or padding gives the same key. Payloads
 * without a transaction group are keyed by their whole content, keys sorted.
 */
export function paymentKey(payload: unknown): string {
  const hash = createHash("sha256");
  const group = (payload as { paymentGroup?: unknown } | null)?.paymentGroup;
  if (Array.isArray(group) && group.every((t) => typeof t === "string")) {
    for (const txn of group as string[]) {
      const bytes = Buffer.from(txn, "base64");
      hash.update(String(bytes.length)).update(":").update(bytes);
    }
  } else {
    hash.update(canonical(payload));
  }
  return hash.digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
