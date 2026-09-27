/**
 * Presidio analyzer client. Presidio runs on ChainAim's private network, and
 * no text goes anywhere else until Presidio's answer has been used to mask
 * it. Every failure is a PresidioError, which the routes turn into 503 (fail
 * closed).
 */
import { AD_HOC_RECOGNIZERS, DETECTED_ENTITIES, REQUIRED_PRESIDIO_ENTITIES, type Detected } from "./entities.ts";

export class PresidioError extends Error {}

export type PresidioOptions = {
  url: string;
  /** Minimum entity score (spec: 0.4). */
  threshold: number;
  timeoutMs: number;
  /** Parallel /analyze calls when a conversation has several texts. */
  concurrency?: number;
};

export class PresidioClient {
  readonly url: string;
  /** Result of the last health check or call; /healthz reports it. */
  healthy = false;
  private readonly opts: PresidioOptions;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: PresidioOptions) {
    this.opts = opts;
    this.url = opts.url.replace(/\/+$/, "");
  }

  /** Entities in `text`: UTF-16 offsets, whitespace trimmed, overlaps resolved, sorted by start. `signal` cancels the call. */
  async analyze(text: string, signal?: AbortSignal): Promise<Detected[]> {
    if (text.trim() === "") return []; // Presidio rejects empty text, and there is nothing to find
    const raw = await this.call(
      "/analyze",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          language: "en",
          score_threshold: this.opts.threshold,
          entities: DETECTED_ENTITIES,
          ad_hoc_recognizers: AD_HOC_RECOGNIZERS,
        }),
      },
      signal,
    );
    if (!Array.isArray(raw)) throw this.fail("/analyze returned an unexpected shape");
    return postProcess(text, raw.map((r) => this.parseResult(r)));
  }

  /** analyze() for several texts, a few calls at a time; results keep the input order. Once `signal` aborts, no new call starts. */
  analyzeAll(texts: readonly string[], signal?: AbortSignal): Promise<Detected[][]> {
    return mapLimit(texts, this.opts.concurrency ?? 4, (t) => this.analyze(t, signal), signal);
  }

  async supportedEntities(): Promise<string[]> {
    const raw = await this.call("/supportedentities?language=en");
    if (!Array.isArray(raw) || !raw.every((e) => typeof e === "string")) throw this.fail("/supportedentities returned an unexpected shape");
    return raw as string[];
  }

  /** GET /health; updates `healthy`. */
  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      await res.body?.cancel().catch(() => undefined); // cancel() rejects when the stream already failed
      this.healthy = res.ok;
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.checkHealth(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private parseResult(r: unknown): Detected {
    const o = r as { entity_type?: unknown; start?: unknown; end?: unknown; score?: unknown } | null;
    const start = o?.start;
    const end = o?.end;
    if (typeof o?.entity_type !== "string" || !Number.isInteger(start) || !Number.isInteger(end) || typeof o.score !== "number" || (start as number) < 0 || (end as number) < (start as number)) {
      // Skipping a malformed entity could leave a value unmasked, so the whole call fails.
      throw this.fail("/analyze returned a malformed entity");
    }
    return { type: o.entity_type, start: start as number, end: end as number, score: o.score };
  }

  private fail(message: string): PresidioError {
    this.healthy = false;
    return new PresidioError(`presidio ${message}`);
  }

  /** A call the caller cancelled says nothing about Presidio, so health is left as it is. */
  private failUnlessCancelled(signal: AbortSignal | undefined, message: string): PresidioError {
    return signal?.aborted ? new PresidioError(`presidio ${message} (cancelled by the caller)`) : this.fail(message);
  }

  private async call(path: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    } catch (e) {
      throw this.failUnlessCancelled(signal, `${path}: ${(e as Error).name}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined); // cancel() rejects when the stream already failed
      throw this.fail(`${path}: HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw this.failUnlessCancelled(signal, `${path}: the response is not JSON`);
    }
    this.healthy = true;
    return body;
  }
}

/**
 * Presidio (Python) counts code points; JavaScript strings count UTF-16 units.
 * Convert, trim whitespace at span edges, and resolve overlaps.
 */
export function postProcess(text: string, found: readonly Detected[]): Detected[] {
  const toUtf16 = utf16Index(text);
  const spans: Detected[] = [];
  for (const d of found) {
    let start = toUtf16(d.start);
    let end = toUtf16(d.end);
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end > start) spans.push({ type: d.type, start, end, score: d.score });
  }
  return resolveOverlaps(spans);
}

function utf16Index(text: string): (codePoint: number) => number {
  if (!/[\uD800-\uDFFF]/.test(text)) {
    return (cp) => {
      if (cp > text.length) throw new PresidioError(`presidio offset ${cp} is outside the text`);
      return cp;
    };
  }
  const units: number[] = [];
  let u = 0;
  for (const ch of text) {
    units.push(u);
    u += ch.length;
  }
  units.push(u);
  return (cp) => {
    const i = units[cp];
    if (i === undefined) throw new PresidioError(`presidio offset ${cp} is outside the text`);
    return i;
  };
}

/** Overlapping spans: the longer wins; on equal length, the higher score. The result is sorted by start. */
export function resolveOverlaps(spans: readonly Detected[]): Detected[] {
  const ranked = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || b.score - a.score || a.start - b.start);
  const kept: Detected[] = [];
  for (const s of ranked) {
    if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * The start-up check's test sentence, built from synthetic corpus values
 * (scripts/synthetic-corpus.ts). The name needs the NLP model, the e-mail is
 * a pattern, and the record number needs ChainAim's ad-hoc recognizer and its
 * context word "MRN".
 */
const CANARY = "Patient Jane Roe, MRN 991122, can be reached at jane.roe@example.com.";
const CANARY_TYPES: readonly string[] = ["PERSON", "EMAIL_ADDRESS", "MEDICAL_RECORD"];

/**
 * Start-up check (V4): wait until Presidio answers, then refuse to run if a
 * required built-in entity is missing, or if the test sentence does not come
 * back with a name, an e-mail and a medical record number. A wrong answer
 * fails at once (naming entity types only, never the sentence); an
 * unreachable Presidio, or a failed call, is retried every pauseMs until
 * waitMs runs out.
 */
export async function waitForPresidio(presidio: PresidioClient, waitMs: number, pauseMs = 2000): Promise<void> {
  const deadline = Date.now() + waitMs;
  const answer = async <T>(call: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await call();
      } catch (e) {
        if (Date.now() + pauseMs > deadline) throw new Error(`Presidio at ${presidio.url} did not answer within ${waitMs} ms (${(e as Error).message})`);
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
  };
  const have = new Set(await answer(() => presidio.supportedEntities()));
  const missing = REQUIRED_PRESIDIO_ENTITIES.filter((e) => !have.has(e));
  if (missing.length > 0) {
    throw new Error(`Presidio at ${presidio.url} does not support ${missing.join(", ")}; deploy services/presidio, which enables them`);
  }
  const found = new Set((await answer(() => presidio.analyze(CANARY))).map((e) => e.type));
  const undetected = CANARY_TYPES.filter((t) => !found.has(t));
  if (undetected.length > 0) {
    throw new Error(`Presidio at ${presidio.url} did not detect ${undetected.join(", ")} in the start-up test sentence; deploy services/presidio, which detects them`);
  }
}

/**
 * fn over items, `limit` calls at a time, results in input order. Once a call
 * has failed or `signal` has aborted, no new call starts and the whole map
 * fails, so a caller never gets results with gaps.
 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      if (signal?.aborted) throw new PresidioError("presidio: cancelled by the caller");
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
