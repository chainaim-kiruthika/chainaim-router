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

  /** Entities in `text`: UTF-16 offsets, whitespace trimmed, overlaps resolved, sorted by start. */
  async analyze(text: string): Promise<Detected[]> {
    if (text.trim() === "") return []; // Presidio rejects empty text, and there is nothing to find
    const raw = await this.call("/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        language: "en",
        score_threshold: this.opts.threshold,
        entities: DETECTED_ENTITIES,
        ad_hoc_recognizers: AD_HOC_RECOGNIZERS,
      }),
    });
    if (!Array.isArray(raw)) throw this.fail("/analyze returned an unexpected shape");
    return postProcess(text, raw.map((r) => this.parseResult(r)));
  }

  /** analyze() for several texts, a few calls at a time; results keep the input order. */
  analyzeAll(texts: readonly string[]): Promise<Detected[][]> {
    return mapLimit(texts, this.opts.concurrency ?? 4, (t) => this.analyze(t));
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
      await res.body?.cancel();
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

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      throw this.fail(`${path}: ${(e as Error).name}`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw this.fail(`${path}: HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw this.fail(`${path}: the response is not JSON`);
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
 * Start-up check (V4): wait until Presidio answers, then refuse to run if a
 * required built-in entity is missing. A missing entity fails at once; an
 * unreachable Presidio is retried every pauseMs until waitMs runs out.
 */
export async function waitForPresidio(presidio: PresidioClient, waitMs: number, pauseMs = 2000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let supported: string[];
    try {
      supported = await presidio.supportedEntities();
    } catch (e) {
      if (Date.now() + pauseMs > deadline) throw new Error(`Presidio at ${presidio.url} did not answer within ${waitMs} ms (${(e as Error).message})`);
      await new Promise((r) => setTimeout(r, pauseMs));
      continue;
    }
    const have = new Set(supported);
    const missing = REQUIRED_PRESIDIO_ENTITIES.filter((e) => !have.has(e));
    if (missing.length > 0) {
      throw new Error(`Presidio at ${presidio.url} does not support ${missing.join(", ")}; deploy services/presidio, which enables them`);
    }
    return;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
