import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("needs PAYWALL_URL", () => {
    assert.throws(() => loadConfig({}), /PAYWALL_URL/);
  });

  it("rejects a PAYWALL_URL that is not http(s)", () => {
    assert.throws(() => loadConfig({ PAYWALL_URL: "ftp://example.com" }), /PAYWALL_URL/);
  });

  it("applies the defaults and trims a trailing slash", () => {
    assert.deepEqual(loadConfig({ PAYWALL_URL: "http://127.0.0.1:8080/" }), { port: 8740, host: "127.0.0.1", paywallUrl: "http://127.0.0.1:8080" });
  });

  it("reads overrides", () => {
    const c = loadConfig({ PAYWALL_URL: "https://paywall.example", PORT: "9000", HOST: "0.0.0.0" });
    assert.deepEqual([c.port, c.host], [9000, "0.0.0.0"]);
  });

  it("rejects a port out of range", () => {
    assert.throws(() => loadConfig({ PAYWALL_URL: "http://x.test", PORT: "abc" }), /PORT/);
    assert.throws(() => loadConfig({ PAYWALL_URL: "http://x.test", PORT: "70000" }), /PORT/);
  });
});
