import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { networkInfo, networkName, readQuote } from "../src/wallets.ts";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAYTO = "EA7WASZQYXGGRSMGYQLRI6TR2PQCVDC42QULUT5N62UMYO4A6ADCJ6464M";

const header = (accepts: unknown) => Buffer.from(JSON.stringify({ accepts })).toString("base64");
const quoteFetch = (status: number, accepts?: unknown) => async () =>
  new Response("{}", { status, headers: accepts === undefined ? {} : { "payment-required": header(accepts) } });

describe("networkName", () => {
  it("recognises TestNet and MainNet by their genesis hashes", () => {
    assert.equal(networkName(TESTNET), "testnet");
    assert.equal(networkName("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="), "mainnet");
    assert.equal(networkName("eip155:8453"), "unknown");
  });
});

describe("readQuote", () => {
  it("reads the pay-to address, network, asset and the price in USDC", async () => {
    const q = await readQuote("http://paywall.test", "/v1/chat/completions", quoteFetch(402, [{ network: TESTNET, amount: "10000", asset: "10458941", payTo: PAYTO }]));
    assert.deepEqual(q, { payTo: PAYTO, network: TESTNET, asset: "10458941", price: 0.01 });
  });

  it("posts to the route it was given", async () => {
    let seen = "";
    await readQuote("http://paywall.test", "/v1/privacy/scan", async (input) => {
      seen = String(input);
      return new Response("{}", { status: 402, headers: { "payment-required": header([{ network: TESTNET, amount: "2000", asset: "1", payTo: PAYTO }]) } });
    });
    assert.equal(seen, "http://paywall.test/v1/privacy/scan");
  });

  it("fails clearly when the paywall does not quote a price", async () => {
    await assert.rejects(readQuote("http://paywall.test", "/x", quoteFetch(503)), /did not quote a price \(HTTP 503\)/);
  });

  it("fails clearly when the quote has the wrong shape", async () => {
    await assert.rejects(readQuote("http://paywall.test", "/x", quoteFetch(402, [{ network: TESTNET }])), /not in the expected shape/);
  });
});

describe("networkInfo", () => {
  it("gives the genesis ID and algod node for a known network, and null otherwise", () => {
    assert.deepEqual(networkInfo("testnet"), { genesisId: "testnet-v1.0", algodUrl: "https://testnet-api.algonode.cloud" });
    assert.equal(networkInfo("unknown"), null);
  });
});
