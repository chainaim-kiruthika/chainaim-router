/**
 * Decision ledger: one JSON line per request.
 *
 * It records classes, counts, sizes, the routing decision and every attempt.
 * It never records request or response text, placeholders or the placeholder
 * map, so the file is not a copy of sensitive data.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Attempt } from "./dispatch.ts";
import type { Decision, RequestFeatures } from "./engine.ts";
import type { DataClass, FoundClass } from "./privacy/classify.ts";

/** A chat request routed by profile (retired in Task C9). */
export type RoutedEntry = {
  ts: string;
  decisionId: string;
  requestedModel?: string;
  decision: Omit<Decision, "reasoning"> & { reasoning?: string };
  request: Pick<RequestFeatures, "maxOutputTokens" | "hasTools" | "requiresTools" | "hasVision" | "requiresStructuredOutput" | "promptChars"> & { stream: boolean };
  served?: { model: string; deployment: string };
  attempts: Attempt[];
  status: number;
  latencyMs: number;
};

/** A scan or mask call: what was found, never the text. */
export type PrivacyEntry = {
  ts: string;
  decisionId: string;
  endpoint: "scan" | "mask";
  dataClass?: DataClass;
  found?: FoundClass[];
  entityCounts?: Record<string, number>;
  cardsRemoved?: number;
  status: number;
  latencyMs: number;
  textChars: number;
};

export type LedgerEntry = RoutedEntry | PrivacyEntry;

export class Ledger {
  private readonly dir: string | undefined;

  /** @param dir directory for daily files, or undefined to disable */
  constructor(dir: string | undefined) {
    this.dir = dir;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get enabled(): boolean {
    return this.dir !== undefined;
  }

  write(entry: LedgerEntry): void {
    if (!this.dir) return;
    const file = join(this.dir, `decisions-${entry.ts.slice(0, 10)}.jsonl`);
    // Synchronous append keeps lines whole under concurrency; volume is one small line per request.
    appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  }
}
