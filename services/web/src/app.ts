/**
 * The PrivacyBuddy web app: the page, the browser masking module, the wallet
 * read, and the one paid action (execute). Everything it depends on is passed
 * in, so the tests run it with a fake payer and a stand-in paywall.
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Payer } from "./buyer.ts";
import { Limits } from "./limits.ts";
import { detect } from "./mask.ts";
import { networkName, readQuote, type Quote } from "./wallets.ts";
import { readBalance, type Balance } from "./balance.ts";

const CHAT = "/v1/chat/completions";
const SCAN = "/v1/privacy/scan";
/** The gateway's chat limit, in characters of message text. */
export const MAX_MASKED_CHARS = 48_000;

export type Deps = {
  paywallUrl: string;
  ratePerMinute: number;
  maxExecutesPerHour: number;
  buyer: Payer | undefined;
  /** client-mask.ts as browser JavaScript. */
  maskModule: string;
  /** The page, read on every request so an edit shows without a restart. */
  pageFile: URL;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Status, sizes and timing only. Never text, placeholders or the map. */
  log?: (line: Record<string, unknown>) => void;
};

const fail = (c: Context, status: 400 | 402 | 429 | 502 | 503, message: string) => c.json({ error: { message } }, status);

function cached<T>(ttlMs: number, now: () => number, load: () => Promise<T>): () => Promise<T> {
  let value: { at: number; v: T } | undefined;
  return async () => {
    if (value && now() - value.at < ttlMs) return value.v;
    const v = await load();
    value = { at: now(), v };
    return v;
  };
}

export function createWebApp(deps: Deps): Hono {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const limits = new Limits(deps.ratePerMinute, deps.maxExecutesPerHour, now);

  // The chat quote carries the price; if chat cannot be quoted (no capacity), the scan quote still gives the pay-to address and network.
  const quote = cached<{ quote: Quote; priced: boolean }>(30_000, now, async () => {
    try {
      return { quote: await readQuote(deps.paywallUrl, CHAT, fetcher), priced: true };
    } catch {
      return { quote: await readQuote(deps.paywallUrl, SCAN, fetcher), priced: false };
    }
  });
  const balance = cached<Balance | undefined>(15_000, now, async () => {
    if (!deps.buyer) return undefined;
    const { quote: q } = await quote();
    const network = networkName(q.network);
    return network === "unknown" ? undefined : readBalance(deps.buyer.address, network, q.asset, fetcher);
  });

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
  });

  app.get("/", async (c) => c.html(await readFile(deps.pageFile, "utf8")));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/client-mask.js", (c) => c.body(deps.maskModule, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }));

  app.get("/api/wallets", async (c) => {
    const q = await quote().catch(() => undefined);
    const b = await balance().catch(() => undefined);
    return c.json({
      network: q ? networkName(q.quote.network) : "unknown",
      asset: q?.quote.asset ?? null,
      buyer: deps.buyer ? { address: deps.buyer.address, usdc: b?.usdc ?? null, algo: b?.algo ?? null, optedIn: b?.optedIn ?? null } : null,
      payTo: q ? { address: q.quote.payTo } : null,
      prices: { chat: q?.priced ? q.quote.price : null },
    });
  });

  registerExecute(app, { deps, limits, quote, balance, now, log });

  app.notFound((c) => c.json({ error: { message: "Not found." } }, 404));
  return app;
}

type ExecuteCtx = {
  deps: Deps;
  limits: Limits;
  quote: () => Promise<{ quote: Quote; priced: boolean }>;
  balance: () => Promise<Balance | undefined>;
  now: () => number;
  log: (line: Record<string, unknown>) => void;
};

/** What to tell the user about a failed paid call. The gateway's own messages hold no user text. */
function upstreamMessage(status: number, text: string): string {
  let message = "";
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === "string") message = m;
  } catch {
    /* not JSON */
  }
  if (status === 402) return "The payment was not accepted. The buyer wallet may need TestNet USDC. You were not charged.";
  if (message) return message.slice(0, 300);
  return `The chat service failed (HTTP ${status}). You were not charged.`;
}

function registerExecute(app: Hono, ctx: ExecuteCtx): void {
  const { deps, limits, quote, balance, now, log } = ctx;

  app.post("/api/execute", async (c) => {
    const started = now();
    const done = (status: number, extra: Record<string, unknown> = {}) => log({ route: "execute", status, ms: now() - started, ...extra });

    const body = (await c.req.json().catch(() => undefined)) as { masked?: unknown; maxTokens?: unknown } | undefined;
    const masked = typeof body?.masked === "string" ? body.masked : "";
    if (masked.trim() === "") {
      done(400);
      return fail(c, 400, "Write a message and mask it first.");
    }
    if (masked.length > MAX_MASKED_CHARS) {
      done(400);
      return fail(c, 400, `That message is ${masked.length} characters after masking; the limit is ${MAX_MASKED_CHARS}.`);
    }
    const maxTokens = body?.maxTokens === undefined ? 512 : body.maxTokens;
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024) {
      done(400);
      return fail(c, 400, "maxTokens must be a whole number from 1 to 1024.");
    }
    // The same self-check as scripts/private-ask.ts: only text with nothing left to mask goes on, even if someone posts here directly.
    if (detect(masked).length > 0) {
      done(400);
      return fail(c, 400, "That text still holds values that should be masked, such as an email, a phone number or a card number. Mask it first. Nothing was sent or paid.");
    }
    if (!deps.buyer) {
      done(503);
      return fail(c, 503, "The demo buyer wallet is not set up on this server.");
    }
    const visitor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const limited = limits.take(visitor);
    if (limited) {
      done(429);
      return fail(c, 429, limited === "visitor" ? "Too many requests. Wait a minute and try again." : "The demo has reached its hourly limit. Try again later.");
    }

    // Only stop when we know the wallet is short; if the balance cannot be read, the paywall decides.
    const q = await quote().catch(() => undefined);
    const b = await balance().catch(() => undefined);
    if (q?.priced && b && b.usdc < q.quote.price) {
      done(402);
      return fail(c, 402, `The demo buyer wallet has ${b.usdc} USDC and this answer costs ${q.quote.price}. Fund it with TestNet USDC and try again. Nothing was sent.`);
    }

    let response: Response;
    try {
      response = await deps.buyer.fetchPaid(deps.paywallUrl + CHAT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens }),
      });
    } catch {
      done(502);
      return fail(c, 502, "Could not reach the payment service. You were not charged.");
    }
    const text = await response.text();
    if (!response.ok) {
      done(502, { upstream: response.status });
      return fail(c, 502, upstreamMessage(response.status, text));
    }
    let answer: unknown;
    try {
      answer = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    } catch {
      answer = undefined;
    }
    if (typeof answer !== "string") {
      done(502, { upstream: 200 });
      return fail(c, 502, "The model's answer could not be read. Check the payment receipt before trying again.");
    }
    const settled = deps.buyer.settlement(response);
    done(200, { maskedChars: masked.length });
    return c.json({
      answer,
      model: response.headers.get("x-chainaim-model"),
      dataClass: response.headers.get("x-chainaim-data-class"),
      payment: { transaction: settled?.transaction ?? null, network: settled?.network ?? null },
    });
  });
}
