/**
 * Which free models may serve a request, and in what order (spec section 6).
 * Pure functions, plus the cache of models that have no provider meeting the
 * no-collection data policy.
 */
import type { FreeModel } from "./freepool.ts";
import { entryFor, scoreOf, SPEED_RANK, type ScoreTable, type Task } from "./scores.ts";

export type Need = { task: Task; difficulty: number; phi: boolean; hasTools: boolean; wantsJson: boolean; promptTokens: number; maxTokens: number };
export type Excluders = { coolingDown: (id: string) => boolean; denyUnavailable: (id: string) => boolean };
export type Filter = "tools" | "response_format" | "context_length" | "max_output_tokens" | "data_policy" | "cooling_down";

/** The first eligibility filter a model fails, or undefined when it may serve the request. */
export function failedFilter(m: FreeModel, need: Need, ex: Excluders): Filter | undefined {
  if (need.hasTools && !m.tools) return "tools";
  if (need.wantsJson && !m.json) return "response_format";
  if (need.promptTokens + need.maxTokens > m.contextLength) return "context_length";
  if (need.maxTokens > m.maxOutput) return "max_output_tokens";
  if (need.phi && ex.denyUnavailable(m.id)) return "data_policy";
  if (ex.coolingDown(m.id)) return "cooling_down";
  return undefined;
}

/** Eligible models, best first, and why the others were left out. */
export function rank(models: readonly FreeModel[], table: ScoreTable, need: Need, ex: Excluders): { ranked: { id: string; score: number }[]; excluded: Record<string, string> } {
  const excluded: Record<string, string> = {};
  const scored: { id: string; score: number; speed: number }[] = [];
  for (const m of models) {
    const why = failedFilter(m, need, ex);
    if (why) {
      excluded[m.id] = why;
      continue;
    }
    const entry = entryFor(table, m.id);
    scored.push({ id: m.id, score: scoreOf(table, entry, need), speed: SPEED_RANK[entry.speed] });
  }
  scored.sort((a, b) => b.score - a.score || a.speed - b.speed || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ranked: scored.map(({ id, score }) => ({ id, score })), excluded };
}

/** A set whose entries expire: the deny-unavailable cache (spec section 7, 6 hours in production). */
export class ExpiringSet {
  private readonly until = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  add(id: string, now = Date.now()): void {
    this.until.set(id, now + this.ttlMs);
  }

  has(id: string, now = Date.now()): boolean {
    const t = this.until.get(id);
    if (t === undefined) return false;
    if (t <= now) {
      this.until.delete(id);
      return false;
    }
    return true;
  }
}
