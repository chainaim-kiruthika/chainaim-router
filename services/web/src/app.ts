/**
 * The PrivacyBuddy web app: the page, the browser masking module, the wallet
 * bundle, what the paywall asks for, and the paid chat relay. The server holds
 * no wallet key: the visitor's Lute wallet signs each payment in the browser.
 * Everything it depends on is passed in, so the tests run it with a stand-in paywall.
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { MAX_MASKED_CHARS, registerRelay } from "./relay.ts";
import { networkInfo, networkName, readQuote, type Quote } from "./wallets.ts";

export { MAX_MASKED_CHARS };

const CHAT = "/v1/chat/completions";
const SCAN = "/v1/privacy/scan";
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' https://testnet-api.algonode.cloud https://mainnet-api.algonode.cloud; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
/** Sent on every response; scripts/build-vercel.ts gives Vercel's static files the same set. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export type Deps = {
  paywallUrl: string;
  /** client-mask.ts as browser JavaScript. */
  maskModule: string;
  /** The page, read on every request so an edit shows without a restart. */
  pageFile: URL;
  /** public/wallet.js: the Lute and x402 browser bundle (npm run build:wallet). */
  walletFile: URL;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Status, sizes and timing only. Never text, placeholders, the map or the payment. */
  log?: (line: Record<string, unknown>) => void;
};

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

  // The chat quote carries the price; if chat cannot be quoted (no capacity), the scan quote still gives the pay-to address and network.
  const quote = cached<{ quote: Quote; priced: boolean }>(30_000, now, async () => {
    try {
      return { quote: await readQuote(deps.paywallUrl, CHAT, fetcher), priced: true };
    } catch {
      return { quote: await readQuote(deps.paywallUrl, SCAN, fetcher), priced: false };
    }
  });

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  });

  app.get("/", async (c) => c.html(await readFile(deps.pageFile, "utf8")));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/client-mask.js", (c) => c.body(deps.maskModule, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }));
  app.get("/wallet.js", async (c) => {
    const js = await readFile(deps.walletFile, "utf8").catch(() => undefined);
    if (js === undefined) return c.json({ error: { message: "public/wallet.js is not built. Run npm run build:wallet." } }, 404);
    return c.body(js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
  });

  app.get("/api/wallets", async (c) => {
    const q = await quote().catch(() => undefined);
    const network = q ? networkName(q.quote.network) : "unknown";
    const info = networkInfo(network);
    return c.json({
      network,
      genesisId: info?.genesisId ?? null,
      algodUrl: info?.algodUrl ?? null,
      asset: q?.quote.asset ?? null,
      payTo: q ? { address: q.quote.payTo } : null,
      prices: { chat: q?.priced ? q.quote.price : null },
    });
  });

  registerRelay(app, { paywallUrl: deps.paywallUrl, fetcher, now, log });

  app.notFound((c) => c.json({ error: { message: "Not found." } }, 404));
  return app;
}
