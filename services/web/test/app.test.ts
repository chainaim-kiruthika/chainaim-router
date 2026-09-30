import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Payer } from "../src/buyer.ts";
import { createWebApp, MAX_MASKED_CHARS } from "../src/app.ts";
import { browserMaskModule } from "../src/mask.ts";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAYTO = "EA7WASZQYXGGRSMGYQLRI6TR2PQCVDC42QULUT5N62UMYO4A6ADCJ6464M";
const PAGE = new URL("../public/index.html", import.meta.url);

const quoteHeader = (amount = "10000") =>
  Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", network: TESTNET, amount, asset: "10458941", payTo: PAYTO }] })).toString("base64");

/** A stand-in for the paywall's quote and for a public Algorand node. */
function fakeFetch(opts: { usdc?: number; quote?: boolean; nodeDown?: boolean } = {}) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/v1/")) {
      if (opts.quote === false) return new Response("{}", { status: 503 });
      return new Response("{}", { status: 402, headers: { "payment-required": quoteHeader() } });
    }
    if (url.includes("/v2/accounts/")) {
      if (opts.nodeDown) throw new Error("node down");
      return Response.json({ amount: 4_000_000, assets: opts.usdc === undefined ? [] : [{ "asset-id": 10458941, amount: Math.round(opts.usdc * 1e6) }] });
    }
    throw new Error("unexpected request " + url);
  };
}

function fakePayer(respond: (body: any) => Response | Promise<Response>) {
  const calls: { url: string; body: any }[] = [];
  const payer: Payer = {
    address: "BUYERADDRESS",
    fetchPaid: async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      return respond(body);
    },
    settlement: () => ({ success: true, transaction: "TXID123", network: TESTNET }),
  };
  return { payer, calls };
}

export function makeApp(over: Partial<Parameters<typeof createWebApp>[0]> = {}) {
  const logs: Record<string, unknown>[] = [];
  const app = createWebApp({
    paywallUrl: "http://paywall.test",
    ratePerMinute: 100,
    maxExecutesPerHour: 100,
    buyer: undefined,
    maskModule: browserMaskModule(),
    pageFile: PAGE,
    fetcher: fakeFetch({ usdc: 5 }),
    log: (line) => logs.push(line),
    ...over,
  });
  return { app, logs };
}

describe("page and static routes", () => {
  it("serves the page with security headers", async () => {
    const { app } = makeApp();
    const r = await app.request("/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(await r.text(), /PrivacyBuddy/);
  });

  it("answers /healthz", async () => {
    const r = await makeApp().app.request("/healthz");
    assert.deepEqual(await r.json(), { status: "ok" });
  });

  it("serves the masking module as JavaScript", async () => {
    const r = await makeApp().app.request("/client-mask.js");
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    assert.match(await r.text(), /export function maskText/);
  });

  it("answers an unknown path with a JSON 404", async () => {
    const r = await makeApp().app.request("/nope");
    assert.equal(r.status, 404);
    assert.ok((await r.json() as any).error.message);
  });
});

describe("GET /api/wallets", () => {
  it("shows the buyer with its balance, the pay-to address, the network and the chat price", async () => {
    const { payer } = fakePayer(() => new Response("{}"));
    const r = await makeApp({ buyer: payer }).app.request("/api/wallets");
    assert.deepEqual(await r.json(), {
      network: "testnet",
      asset: "10458941",
      buyer: { address: "BUYERADDRESS", usdc: 5, algo: 4, optedIn: true },
      payTo: { address: PAYTO },
      prices: { chat: 0.01 },
    });
  });

  it("shows buyer null when no key is set", async () => {
    const body = (await (await makeApp().app.request("/api/wallets")).json()) as any;
    assert.equal(body.buyer, null);
    assert.equal(body.payTo.address, PAYTO);
  });

  it("still answers when the paywall cannot quote: unknown network, no pay-to", async () => {
    const { payer } = fakePayer(() => new Response("{}"));
    const body = (await (await makeApp({ buyer: payer, fetcher: fakeFetch({ quote: false }) }).app.request("/api/wallets")).json()) as any;
    assert.deepEqual([body.network, body.payTo, body.prices.chat], ["unknown", null, null]);
  });

  it("leaves the balance null when the Algorand node is down", async () => {
    const { payer } = fakePayer(() => new Response("{}"));
    const body = (await (await makeApp({ buyer: payer, fetcher: fakeFetch({ nodeDown: true }) }).app.request("/api/wallets")).json()) as any;
    assert.deepEqual([body.buyer.address, body.buyer.usdc, body.buyer.algo], ["BUYERADDRESS", null, null]);
  });

  it("never puts anything but the public address in the answer", async () => {
    const { payer } = fakePayer(() => new Response("{}"));
    const text = await (await makeApp({ buyer: payer }).app.request("/api/wallets")).text();
    assert.ok(!/mnemonic|secret|seed/i.test(text));
  });
});

export { fakeFetch, fakePayer, MAX_MASKED_CHARS };

const ok = (content = "Here is your answer for <C_PERSON_1>.") =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "x-chainaim-model": "free/model:free", "x-chainaim-data-class": "PII" } });

const post = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/execute", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const errorOf = async (r: Response) => ((await r.json()) as any).error.message as string;

describe("POST /api/execute", () => {
  it("pays the chat route with only the masked text and returns the answer and the receipt", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const { app } = makeApp({ buyer: payer });
    const r = await post(app, { masked: "Write to <C_PERSON_1> about the refund." });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      answer: "Here is your answer for <C_PERSON_1>.",
      model: "free/model:free",
      dataClass: "PII",
      payment: { transaction: "TXID123", network: TESTNET },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://paywall.test/v1/chat/completions");
    assert.deepEqual(calls[0].body, { model: "chainaim/auto", messages: [{ role: "user", content: "Write to <C_PERSON_1> about the refund." }], max_tokens: 512 });
  });

  it("passes a valid maxTokens on", async () => {
    const { payer, calls } = fakePayer(() => ok());
    await post(makeApp({ buyer: payer }).app, { masked: "hi", maxTokens: 100 });
    assert.equal(calls[0].body.max_tokens, 100);
  });

  it("refuses an empty message, a bad body and a bad maxTokens without paying", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const { app } = makeApp({ buyer: payer });
    assert.equal((await post(app, { masked: "   " })).status, 400);
    assert.equal((await post(app, "not json")).status, 400);
    assert.equal((await post(app, { masked: "hi", maxTokens: 0 })).status, 400);
    assert.equal((await post(app, { masked: "hi", maxTokens: 2000 })).status, 400);
    assert.equal((await post(app, { masked: "hi", maxTokens: "9" })).status, 400);
    assert.equal(calls.length, 0);
  });

  it("refuses text over the limit without paying", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const r = await post(makeApp({ buyer: payer }).app, { masked: "a".repeat(MAX_MASKED_CHARS + 1) });
    assert.equal(r.status, 400);
    assert.match(await errorOf(r), /limit is 48000/);
    assert.equal(calls.length, 0);
  });

  it("refuses text that still holds a raw value, even when posted directly, and pays nothing", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const r = await post(makeApp({ buyer: payer }).app, { masked: "Email priya.raman@example.com please" });
    assert.equal(r.status, 400);
    assert.match(await errorOf(r), /still holds values that should be masked/);
    assert.equal(calls.length, 0);
  });

  it("says 503 when no buyer key is set", async () => {
    const r = await post(makeApp().app, { masked: "hi" });
    assert.equal(r.status, 503);
    assert.match(await errorOf(r), /not set up/);
  });

  it("limits each visitor per minute and all visitors per hour", async () => {
    const { payer } = fakePayer(() => ok());
    const { app } = makeApp({ buyer: payer, ratePerMinute: 2, maxExecutesPerHour: 3 });
    const a = { "x-forwarded-for": "1.1.1.1" };
    assert.equal((await post(app, { masked: "hi" }, a)).status, 200);
    assert.equal((await post(app, { masked: "hi" }, a)).status, 200);
    const third = await post(app, { masked: "hi" }, a);
    assert.equal(third.status, 429);
    assert.match(await errorOf(third), /Wait a minute/);
    assert.equal((await post(app, { masked: "hi" }, { "x-forwarded-for": "2.2.2.2" })).status, 200);
    const capped = await post(app, { masked: "hi" }, { "x-forwarded-for": "3.3.3.3" });
    assert.equal(capped.status, 429);
    assert.match(await errorOf(capped), /hourly limit/);
  });

  it("does not pay when the buyer is known to be short of USDC", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const r = await post(makeApp({ buyer: payer, fetcher: fakeFetch({ usdc: 0 }) }).app, { masked: "hi" });
    assert.equal(r.status, 402);
    assert.match(await errorOf(r), /has 0 USDC and this answer costs 0.01/);
    assert.equal(calls.length, 0);
  });

  it("lets the paywall decide when the balance cannot be read", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const r = await post(makeApp({ buyer: payer, fetcher: fakeFetch({ nodeDown: true }) }).app, { masked: "hi" });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
  });

  it("passes the gateway's own refusal message on, as a 502", async () => {
    const { payer } = fakePayer(() => new Response(JSON.stringify({ error: { message: "every model tried failed; you were not charged" } }), { status: 503 }));
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
    assert.equal(await errorOf(r), "every model tried failed; you were not charged");
  });

  it("explains a payment the paywall did not accept", async () => {
    const { payer } = fakePayer(() => new Response("{}", { status: 402 }));
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
    assert.match(await errorOf(r), /payment was not accepted.*not charged/);
  });

  it("gives a generic message when the upstream failure has no readable message", async () => {
    const { payer } = fakePayer(() => new Response("<html>boom</html>", { status: 500 }));
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
    assert.match(await errorOf(r), /HTTP 500.*not charged/);
  });

  it("says so when the payment service cannot be reached", async () => {
    const { payer } = fakePayer(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
    assert.match(await errorOf(r), /Could not reach the payment service/);
  });

  it("does not hand on an answer it cannot read", async () => {
    const { payer } = fakePayer(() => new Response("{}", { status: 200 }));
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
  });

  it("never logs the submitted text", async () => {
    const { payer } = fakePayer(() => ok());
    const { app, logs } = makeApp({ buyer: payer });
    await post(app, { masked: "The <C_PERSON_1> secret-marker-7781 asked" });
    assert.ok(logs.length > 0, "something is logged");
    assert.ok(!JSON.stringify(logs).includes("secret-marker-7781"));
    assert.ok(!JSON.stringify(logs).includes("C_PERSON_1"));
  });
});
