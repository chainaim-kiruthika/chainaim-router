import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebApp } from "../src/app.ts";
import { browserMaskModule } from "../src/mask.ts";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAYTO = "EA7WASZQYXGGRSMGYQLRI6TR2PQCVDC42QULUT5N62UMYO4A6ADCJ6464M";
const PAGE = new URL("../public/index.html", import.meta.url);
const WALLET = new URL("../public/wallet.js", import.meta.url);

const quoteHeader = (amount = "10000") =>
  Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", network: TESTNET, amount, asset: "10458941", payTo: PAYTO }] })).toString("base64");

/** A stand-in for the paywall's quote. */
function fakeFetch(opts: { quote?: boolean } = {}) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/v1/")) {
      if (opts.quote === false) return new Response("{}", { status: 503 });
      return new Response("{}", { status: 402, headers: { "payment-required": quoteHeader() } });
    }
    throw new Error("unexpected request " + url);
  };
}

function makeApp(over: Partial<Parameters<typeof createWebApp>[0]> = {}) {
  return createWebApp({
    paywallUrl: "http://paywall.test",
    maskModule: browserMaskModule(),
    pageFile: PAGE,
    walletFile: WALLET,
    fetcher: fakeFetch(),
    ...over,
  });
}

describe("page and static routes", () => {
  it("serves the page with security headers", async () => {
    const r = await makeApp().request("/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self' https:\/\/testnet-api\.algonode\.cloud https:\/\/mainnet-api\.algonode\.cloud;/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(await r.text(), /PrivacyBuddy/);
  });

  it("answers /healthz", async () => {
    assert.deepEqual(await (await makeApp().request("/healthz")).json(), { status: "ok" });
  });

  it("serves the masking module as JavaScript", async () => {
    const r = await makeApp().request("/client-mask.js");
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    assert.match(await r.text(), /export function maskText/);
  });

  it("serves the wallet bundle as JavaScript", async () => {
    const r = await makeApp().request("/wallet.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
  });

  it("answers a JSON 404 for /wallet.js when the bundle is not built", async () => {
    const r = await makeApp({ walletFile: new URL("../public/no-such-file.js", import.meta.url) }).request("/wallet.js");
    assert.equal(r.status, 404);
    assert.match(((await r.json()) as any).error.message, /build:wallet/);
  });

  it("answers an unknown path with a JSON 404, and the old execute route is gone", async () => {
    assert.equal((await makeApp().request("/nope")).status, 404);
    assert.equal((await makeApp().request("/api/execute", { method: "POST" })).status, 404);
  });
});

describe("GET /api/wallets", () => {
  it("shows the network, Lute's genesis ID, the algod node, the pay-to address and the chat price", async () => {
    assert.deepEqual(await (await makeApp().request("/api/wallets")).json(), {
      network: "testnet",
      genesisId: "testnet-v1.0",
      algodUrl: "https://testnet-api.algonode.cloud",
      asset: "10458941",
      payTo: { address: PAYTO },
      prices: { chat: 0.01 },
    });
  });

  it("still answers when the paywall cannot quote", async () => {
    const body = (await (await makeApp({ fetcher: fakeFetch({ quote: false }) }).request("/api/wallets")).json()) as any;
    assert.deepEqual([body.network, body.genesisId, body.algodUrl, body.payTo, body.prices.chat], ["unknown", null, null, null, null]);
  });
});
