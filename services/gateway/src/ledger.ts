/**
 * Decision ledger: one JSON line per request. It records classes, counts,
 * sizes, the routing decision and every attempt. It never records request
 * or response text, placeholders, the placeholder map, tool arguments or
 * upstream error bodies (tested with the synthetic corpus).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatRecord } from "./chat.ts";
import type { DataClass, FoundClass } from "./privacy/classify.ts";

type Base = { ts: string; decisionId: string; status: number; latencyMs: number };

/** A scan or mask call (spec 8.4): what was found, never the text. */
export type PrivacyEntry = Base & {
  endpoint: "scan" | "mask";
  textChars: number;
  dataClass?: DataClass;
  found?: FoundClass[];
  entityCounts?: Record<string, number>;
  cardsRemoved?: number;
};

/** A chat call (spec 8.4). */
export type ChatEntry = Base & { endpoint: "chat" } & ChatRecord;

export type LedgerEntry = PrivacyEntry | ChatEntry;

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
