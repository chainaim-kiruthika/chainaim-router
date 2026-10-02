import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlgorandClient } from "@algorandfoundation/algokit-utils/algorand-client";
import { AFTER_APPROVAL, payWith, SIGN_TIMEOUT, SIGN_TIMEOUT_POPUP, type PayDeps, type PayNetwork } from "../src/pay.ts";
import { CANCELLED, NOT_SIGNED, type WalletTransaction } from "../src/lute-signer.ts";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const BUYER = "EA7WASZQYXGGRSMGYQLRI6TR2PQCVDC42QULUT5N62UMYO4A6ADCJ6464M";
const PAYTO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const NET: PayNetwork = { name: "testnet", genesisId: "testnet-v1.0", algodUrl: "http://algod.test", asset: "10458941" };
const CHAT_URL = "http://web.test/api/chat";
const SIG = new Uint8Array(64).fill(7);

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const REQUIRED = b64({
  x402Version: 2,
  resource: { url: "http://web.test/api/chat" },
  accepts: [{ scheme: "exact", network: TESTNET, amount: "10000", asset: "10458941", payTo: PAYTO, maxTimeoutSeconds: 300, extra: {} }],
});
const ANSWER = JSON.stringify({ choices: [{ message: { content: "Hi <C_PERSON_1>" } }] });

/** An Algorand client with cached suggested params, so building the payment calls no node. */
const algorand = () =>
  AlgorandClient.fromConfig({ algodConfig: { server: "http://algod.test", token: "" } }).setSuggestedParamsCache(
    { consensusVersion: "test", fee: 0n, genesisHash: new Uint8Array(32), genesisId: "testnet-v1.0", minFee: 1000n, flatFee: false, firstValid: 1n, lastValid: 1001n },
    new Date(Date.now() + 3_600_000),
  );

/** A stand-in /api/chat: 402 with the quote first, then `paid` for the request that carries a payment. */
function chatRoute(paid: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req);
    if (!req.headers.get("payment-signature")) return new Response("{}", { status: 402, headers: { "payment-required": REQUIRED } });
    return paid(req);
  }) as typeof fetch;
  return { seen, fetcher };
}

function deps(over: Partial<PayDeps> & { fetch: typeof fetch }): PayDeps {
  return { signTxns: async (txns: WalletTransaction[]) => txns.map(() => SIG), popup: false, chatUrl: CHAT_URL, algorandClient: algorand(), ...over };
}

const ask = (d: PayDeps) => payWith(d, BUYER, NET, "Hi <C_PERSON_1>");

describe("payWith", () => {
  it("returns the answer with its receipt after Lute signs", async () => {
    const route = chatRoute(() => new Response(ANSWER, { headers: { "payment-response": b64({ success: true, transaction: "TX1", network: TESTNET }), "x-chainaim-model": "m:free" } }));
    let signedCalls = 0;
    const a = await ask(deps({ fetch: route.fetcher, onSigned: () => signedCalls++ }));
    assert.deepEqual(a, { answer: "Hi <C_PERSON_1>", model: "m:free", dataClass: null, payment: { transaction: "TX1", network: TESTNET } });
    assert.equal(signedCalls, 1);
    assert.equal(route.seen.length, 2);
    assert.deepEqual(JSON.parse(await route.seen[1].text()), { model: "chainaim/auto", messages: [{ role: "user", content: "Hi <C_PERSON_1>" }], max_tokens: 512 });
  });

  it("says cancelled when the Lute window is closed (code 4100)", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    const signTxns = () => Promise.reject(Object.assign(new Error("User Rejected Request"), { code: 4100 }));
    await assert.rejects(ask(deps({ fetch: route.fetcher, signTxns })), { message: CANCELLED });
    assert.equal(route.seen.length, 1, "no paid request was sent");
  });

  it("says Lute did not answer in time, and with no extension mentions pop-ups", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    const never = () => new Promise<never>(() => {});
    await assert.rejects(ask(deps({ fetch: route.fetcher, signTxns: never, signMs: 20 })), { message: SIGN_TIMEOUT });
    await assert.rejects(ask(deps({ fetch: route.fetcher, signTxns: never, signMs: 20, popup: true })), { message: SIGN_TIMEOUT_POPUP });
    assert.equal(SIGN_TIMEOUT, "Lute did not answer in time. Nothing was paid.");
    assert.equal(SIGN_TIMEOUT_POPUP, "Lute did not answer in time. If no Lute window appeared, allow pop-ups for this page. Nothing was paid.");
  });

  it("keeps 'Lute did not sign' (nothing paid) when Lute leaves our transaction unsigned", async () => {
    const route = chatRoute(() => new Response(ANSWER));
    let signedCalls = 0;
    await assert.rejects(ask(deps({ fetch: route.fetcher, signTxns: async (t) => t.map(() => null), onSigned: () => signedCalls++ })), { message: NOT_SIGNED });
    assert.equal(signedCalls, 0);
  });

  it("warns to check the wallet when the connection fails after signing", async () => {
    const route = chatRoute(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(ask(deps({ fetch: route.fetcher })), { message: AFTER_APPROVAL });
  });

  it("never says 'not charged' for a server error after signing", async () => {
    for (const body of ["<html>oops</html>", JSON.stringify({ error: { message: "every model tried failed; you were not charged" } })]) {
      const route = chatRoute(() => new Response(body, { status: 500 }));
      const a = await ask(deps({ fetch: route.fetcher }));
      assert.deepEqual(a, { error: AFTER_APPROVAL, status: 500, transaction: null });
    }
  });

  it("passes on a server error message that already speaks of the payment, with the receipt", async () => {
    const message = "The answer was lost after your payment went through. Check your wallet's recent transactions before trying again.";
    const route = chatRoute(() => Response.json({ error: { message } }, { status: 502, headers: { "payment-response": b64({ success: true, transaction: "TX9", network: TESTNET }) } }));
    assert.deepEqual(await ask(deps({ fetch: route.fetcher })), { error: message, status: 502, transaction: "TX9" });
  });

  it("carries the receipt when a 5xx after signing is replaced by the wallet warning", async () => {
    const route = chatRoute(() => new Response("{}", { status: 503, headers: { "payment-response": b64({ success: true, transaction: "TX5", network: TESTNET }) } }));
    assert.deepEqual(await ask(deps({ fetch: route.fetcher })), { error: AFTER_APPROVAL, status: 503, transaction: "TX5" });
  });

  it("keeps 'not charged' when the paywall refuses the payment (402)", async () => {
    const route = chatRoute(() => new Response("{}", { status: 402 }));
    const a = await ask(deps({ fetch: route.fetcher }));
    assert.match((a as { error: string }).error, /You were not charged/);
  });

  it("shows the paywall's reason and the network when it refuses the payment", async () => {
    const refusal = () => new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, error: "invalid payment group", accepts: [] }) } });
    const a = (await ask(deps({ fetch: chatRoute(refusal).fetcher }))) as { error: string };
    assert.equal(a.error, "The payment was not accepted (invalid payment group). Check that your wallet holds USDC on TestNet and has opted in to it. You were not charged.");
    const main = (await payWith(deps({ fetch: chatRoute(refusal).fetcher }), BUYER, { ...NET, name: "mainnet" }, "Hi <C_PERSON_1>")) as { error: string };
    assert.match(main.error, /holds USDC on MainNet and has opted in/);
  });
});
