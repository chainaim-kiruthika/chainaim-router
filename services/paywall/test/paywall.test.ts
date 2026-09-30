/**
 * The paywall over real sockets, against the stub facilitator and the stub
 * gateway (spec section 11, item 9).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { CHALLENGE_TAG, NETWORKS } from "../src/config.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const KEY = "test-gateway-key";

type PaymentRequired = { accepts: Record<string, any>[]; resource: { url: string }; extensions?: Record<string, any>; [key: string]: any };
const decode = (header: string | null): PaymentRequired => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
/** A payment payload the stub facilitator accepts: it echoes the first accepted requirement. */
const paymentFor = (required: PaymentRequired): string =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: required.accepts[0], payload: { paymentGroup: ["AAAA"], paymentIndex: 0 }, resource: required.resource })).toString("base64");

describe("paywall (TestNet)", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  const logs: string[] = [];
  let paywall: { url: string; close: () => Promise<void> };

  before(async () => {
    const facilitatorUrl = await listen(facilitator.server);
    const gatewayUrl = await listen(gateway.server);
    paywall = await startPaywall(
      { AVM_PAY_TO: PAY_TO, GATEWAY_URL: gatewayUrl, CHAINAIM_GATEWAY_KEY: KEY, FACILITATOR_URL: facilitatorUrl, PUBLIC_BASE_URL: "https://pay.example.com" },
      (line) => logs.push(line),
    );
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });
  beforeEach(() => {
    gateway.seen.length = 0;
    facilitator.calls.length = 0;
    gateway.state.status = 200;
    gateway.state.capacityStatus = 200;
    gateway.state.capacity = { chatAvailable: true };
    gateway.state.delayMs = 0;
    logs.length = 0;
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${paywall.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const priceOf = async (path: string): Promise<PaymentRequired> => decode((await post(path, { text: "Jane Roe" })).headers.get("payment-required"));

  it("asks for payment with the price, network, payTo, tag and Bazaar metadata", async () => {
    for (const [path, amount] of [["/v1/privacy/scan", "10000"], ["/v1/privacy/mask", "10000"], ["/v1/chat/completions", "10000"]]) {
      const r = await post(path, { text: "Jane Roe" });
      assert.equal(r.status, 402, path);
      const required = decode(r.headers.get("payment-required"));
      const a = required.accepts[0];
      assert.deepEqual([a.scheme, a.network, a.amount, a.asset, a.payTo, a.extra.tag], ["exact", NETWORKS.testnet, amount, "10458941", PAY_TO, CHALLENGE_TAG]);
      assert.equal(required.resource.url, `https://pay.example.com${path}`);
      assert.ok(required.extensions?.bazaar?.info?.input, `${path} carries Bazaar input metadata`);
    }
    assert.deepEqual(gateway.seen.map((s) => s.path), ["/internal/capacity"], "only the capacity guard reached the gateway");
  });

  it("never settles a paid call that the gateway refuses", async () => {
    gateway.state.status = 503;
    const required = await priceOf("/v1/privacy/scan");
    facilitator.calls.length = 0;
    const r = await post("/v1/privacy/scan", { text: "Jane Roe" }, { "payment-signature": paymentFor(required) });
    assert.equal(r.status, 503);
    assert.deepEqual(facilitator.calls, ["/verify"]);
    assert.equal(r.headers.get("payment-response"), null);
    assert.deepEqual(logs, [], "no payment logged");
  });

  it("never settles a paid call whose caller hangs up before the gateway answers", async () => {
    const required = await priceOf("/v1/privacy/scan");
    facilitator.calls.length = 0;
    gateway.state.delayMs = 2000; // the gateway answers only if the paywall is still waiting then
    const held = once(gateway.events, "held");
    const client = new AbortController();
    const headers = { "content-type": "application/json", "payment-signature": paymentFor(required) };
    const call = fetch(`${paywall.url}/v1/privacy/scan`, { method: "POST", headers, body: JSON.stringify({ text: "Jane Roe" }), signal: client.signal }).catch(() => undefined);
    await held;
    const outcome = once(gateway.events, "outcome");
    client.abort();
    await call;
    assert.deepEqual(await outcome, ["dropped"], "the paywall cancelled its gateway call");
    assert.deepEqual(facilitator.calls, ["/verify"], "verified, never settled");
    assert.deepEqual(logs, [], "no payment logged");
  });

  it("settles a served call, returns the receipt and logs the payment without any body", async () => {
    const required = await priceOf("/v1/privacy/mask");
    facilitator.calls.length = 0;
    const r = await post("/v1/privacy/mask", { text: "Jane Roe" }, { "payment-signature": paymentFor(required) });
    assert.equal(r.status, 200);
    assert.deepEqual(facilitator.calls, ["/verify", "/settle"]);
    assert.equal(decode(r.headers.get("payment-response")).transaction, "TX-STUB-1");
    assert.equal(logs.length, 1);
    const line = JSON.parse(logs[0]);
    assert.deepEqual(
      [line.event, line.route, line.amount, line.asset, line.payer, line.transaction],
      ["payment_settled", "POST /v1/privacy/mask", "10000", "10458941", "BUYERADDRESS", "TX-STUB-1"],
    );
    assert.ok(!logs[0].includes("Jane"), "no request text in the payment log");
    assert.equal("decisionId" in line, false, "no decision id in the payment log");
  });

  it("forwards the body with the gateway key and never the payment headers", async () => {
    const required = await priceOf("/v1/privacy/scan");
    gateway.seen.length = 0;
    await post("/v1/privacy/scan", { text: "Jane Roe" }, { "payment-signature": paymentFor(required), "x-payment": "legacy", cookie: "a=b" });
    const s = gateway.seen.find((x) => x.path === "/v1/privacy/scan");
    assert.ok(s, "the paid call reached the gateway");
    assert.equal(s.headers.authorization, `Bearer ${KEY}`);
    for (const h of ["payment-signature", "x-payment", "cookie"]) assert.equal(s.headers[h], undefined, h);
    assert.deepEqual(JSON.parse(s.body), { text: "Jane Roe" });
  });

  it("passes back only content-type, retry-after and x-chainaim headers", async () => {
    const required = await priceOf("/v1/privacy/scan");
    const r = await post("/v1/privacy/scan", { text: "Jane Roe" }, { "payment-signature": paymentFor(required) });
    assert.equal(r.headers.get("x-chainaim-decision-id"), "decision-1");
    assert.equal(r.headers.get("x-internal-note"), null);
  });

  it("the capacity guard answers 503 with Retry-After and no price when chat cannot be served", async () => {
    gateway.state.capacity = { chatAvailable: false, reason: "rate_limited", retryAfterSec: 17 };
    const r = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "17");
    assert.equal(r.headers.get("payment-required"), null);
    assert.match((await r.json()).error.message, /not charged/);
  });

  it("the capacity guard refuses chat when the gateway cannot say (fail closed)", async () => {
    gateway.state.capacityStatus = 404;
    const r = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "60");
    assert.equal(r.headers.get("payment-required"), null);
  });

  it("serves /healthz and /v1/models without payment, with the gateway key", async () => {
    assert.equal((await fetch(`${paywall.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${paywall.url}/v1/models`)).status, 200);
    assert.equal(gateway.seen.length, 2);
    assert.ok(gateway.seen.every((s) => s.headers.authorization === `Bearer ${KEY}`));
    assert.equal(facilitator.calls.length, 0);
  });

  it("rejects bodies over 4 MiB with 413 before any payment step", async () => {
    const r = await post("/v1/privacy/scan", { text: "x".repeat(4_200_000) });
    assert.equal(r.status, 413);
    assert.equal(r.headers.get("payment-required"), null);
  });

  it("answers unknown routes with 404 and no price", async () => {
    const r = await fetch(`${paywall.url}/v1/other`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("payment-required"), null);
  });
});

describe("paywall (MainNet)", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  let paywall: { url: string; close: () => Promise<void> };
  before(async () => {
    paywall = await startPaywall({
      AVM_PAY_TO: PAY_TO,
      GATEWAY_URL: await listen(gateway.server),
      CHAINAIM_GATEWAY_KEY: KEY,
      FACILITATOR_URL: await listen(facilitator.server),
      X402_NETWORK: "mainnet",
    });
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });

  it("prices in MainNet USDC (ASA 31566704)", async () => {
    const r = await fetch(`${paywall.url}/v1/privacy/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"text":"hi"}' });
    const a = decode(r.headers.get("payment-required")).accepts[0];
    assert.deepEqual([a.network, a.asset, a.amount], [NETWORKS.mainnet, "31566704", "10000"]);
  });
});

describe("main", () => {
  it("exits with a clear message when the configuration is missing", () => {
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const env = { ...process.env, AVM_PAY_TO: "", GATEWAY_URL: "", CHAINAIM_GATEWAY_KEY: "" };
    const r = spawnSync(process.execPath, ["src/main.ts"], { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AVM_PAY_TO is required/);
  });
});
