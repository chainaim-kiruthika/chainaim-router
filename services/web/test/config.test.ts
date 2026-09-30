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
    assert.deepEqual(loadConfig({ PAYWALL_URL: "http://127.0.0.1:8080/" }), {
      port: 8740,
      host: "127.0.0.1",
      paywallUrl: "http://127.0.0.1:8080",
      ratePerMinute: 5,
      maxExecutesPerHour: 30,
    });
  });

  it("reads overrides", () => {
    const c = loadConfig({ PAYWALL_URL: "https://paywall.example", PORT: "9000", HOST: "0.0.0.0", RATE_PER_MINUTE: "2", MAX_EXECUTES_PER_HOUR: "10" });
    assert.deepEqual([c.port, c.host, c.ratePerMinute, c.maxExecutesPerHour], [9000, "0.0.0.0", 2, 10]);
  });

  it("rejects a number out of range", () => {
    assert.throws(() => loadConfig({ PAYWALL_URL: "http://x.test", RATE_PER_MINUTE: "0" }), /RATE_PER_MINUTE/);
    assert.throws(() => loadConfig({ PAYWALL_URL: "http://x.test", PORT: "abc" }), /PORT/);
  });
});
