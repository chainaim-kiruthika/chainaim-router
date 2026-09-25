/**
 * Paywall configuration and the paid-route table (spec section 9).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHALLENGE_TAG, loadConfig, NETWORKS } from "../src/config.ts";
import { PAID_ROUTES, routesConfig } from "../src/routes.ts";

const PAY_TO = "IDNTKBLAMSMIBR5DV5GRRZC7PNDOGRUOSOLHZ7BIOVXJPOWT2O24BMVDPE";
const env = { AVM_PAY_TO: PAY_TO, GATEWAY_URL: "http://gateway.railway.internal:8700", CHAINAIM_GATEWAY_KEY: "test-key" };

describe("loadConfig", () => {
  it("defaults to TestNet, the GoPlausible facilitator and port 8080", () => {
    const c = loadConfig(env);
    assert.equal(c.network, "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");
    assert.equal(c.networkName, "testnet");
    assert.equal(c.facilitatorUrl, "https://facilitator.goplausible.xyz");
    assert.equal(c.port, 8080);
    assert.equal(c.host, "0.0.0.0");
    assert.equal(c.publicBaseUrl, undefined);
  });

  it("selects MainNet", () => {
    assert.equal(loadConfig({ ...env, X402_NETWORK: "mainnet" }).network, "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=");
  });

  it("names the variable that is missing or wrong", () => {
    assert.throws(() => loadConfig({ ...env, AVM_PAY_TO: "" }), /AVM_PAY_TO/);
    assert.throws(() => loadConfig({ ...env, AVM_PAY_TO: "not-an-algorand-address" }), /AVM_PAY_TO/);
    assert.throws(() => loadConfig({ ...env, GATEWAY_URL: "" }), /GATEWAY_URL/);
    assert.throws(() => loadConfig({ ...env, GATEWAY_URL: "gateway:8700" }), /GATEWAY_URL/);
    assert.throws(() => loadConfig({ ...env, CHAINAIM_GATEWAY_KEY: "" }), /CHAINAIM_GATEWAY_KEY/);
    assert.throws(() => loadConfig({ ...env, X402_NETWORK: "betanet" }), /X402_NETWORK/);
    assert.throws(() => loadConfig({ ...env, X402_NETWORK: "toString" }), /X402_NETWORK/);
    assert.throws(() => loadConfig({ ...env, PORT: "eighty" }), /PORT/);
  });

  it("needs PUBLIC_BASE_URL to be https and strips a trailing slash", () => {
    assert.equal(loadConfig({ ...env, PUBLIC_BASE_URL: "https://pay.example.com/" }).publicBaseUrl, "https://pay.example.com");
    assert.throws(() => loadConfig({ ...env, PUBLIC_BASE_URL: "http://pay.example.com" }), /PUBLIC_BASE_URL/);
  });
});

describe("paid routes", () => {
  it("prices scan, mask and chat as the spec says", () => {
    assert.deepEqual(
      PAID_ROUTES.map((r) => [r.key, r.price]),
      [["POST /v1/privacy/scan", "$0.002"], ["POST /v1/privacy/mask", "$0.003"], ["POST /v1/chat/completions", "$0.01"]],
    );
  });

  it("puts the scheme, network, payTo and challenge tag on every accepts entry", () => {
    const routes = routesConfig(loadConfig({ ...env, X402_NETWORK: "mainnet", PUBLIC_BASE_URL: "https://pay.example.com" }));
    for (const r of PAID_ROUTES) {
      const entry = routes[r.key];
      assert.deepEqual(entry.accepts, [{ scheme: "exact", price: r.price, network: NETWORKS.mainnet, payTo: PAY_TO, extra: { tag: CHALLENGE_TAG } }]);
      assert.equal(entry.resource, `https://pay.example.com${r.path}`);
      assert.equal(entry.mimeType, "application/json");
      assert.equal(entry.description, r.description);
    }
  });

  it("leaves the resource URL to the request when PUBLIC_BASE_URL is unset", () => {
    const routes = routesConfig(loadConfig(env));
    for (const r of PAID_ROUTES) assert.equal("resource" in routes[r.key], false);
  });

  it("declares Bazaar discovery metadata with an input example and an output example", () => {
    const routes = routesConfig(loadConfig(env));
    type Info = { input: { body: Record<string, unknown> }; output: { example: unknown } };
    const info = (key: string): Info => (routes[key].extensions as { bazaar: { info: Info } }).bazaar.info;
    assert.deepEqual(Object.keys(info("POST /v1/privacy/scan").input.body), ["text"]);
    assert.deepEqual(Object.keys(info("POST /v1/privacy/mask").input.body), ["text"]);
    assert.ok(Array.isArray(info("POST /v1/chat/completions").input.body.messages));
    for (const r of PAID_ROUTES) assert.ok(info(r.key).output.example, `${r.key} has an output example`);
  });
});
