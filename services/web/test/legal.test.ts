import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const PAGE = read("../public/index.html");
const COOKIES = read("../public/cookies.html");

describe("trademark and legal notices", () => {
  it("the footer carries the copyright, the trademark and the links", () => {
    assert.match(PAGE, /© 2026 ChainAim\. PrivacyBuddy™ is a trademark of ChainAim\. All rights reserved\./);
    assert.match(PAGE, /href="https:\/\/github\.com\/chainaimdev\/chainaim-router\/blob\/main\/LICENSE"/);
    assert.match(PAGE, /href="\/cookies\.html"/);
  });

  it("never uses the registered-trademark sign, which needs a registration", () => {
    assert.ok(!PAGE.includes("®") && !COOKIES.includes("®"));
    assert.ok(!read("../../../README.md").includes("®"));
  });

  it("the cookie policy has its own copyright line and a way home", () => {
    assert.match(COOKIES, /PrivacyBuddy™ is a trademark of ChainAim/);
    assert.match(COOKIES, /href="\/"/);
  });
});

describe("the cookie policy tells the truth", () => {
  it("no page or server code sets a cookie, so there is nothing to put a banner on", () => {
    const files = [
      ...readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".ts") && f !== "wallet-entry.ts").map((f) => read(`../src/${f}`)),
      read("../src/wallet-entry.ts"),
      PAGE,
      COOKIES,
    ];
    for (const text of files) assert.ok(!/document\.cookie|[^-]set-cookie/i.test(text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")), "found a cookie being set");
  });

  it("the single browser storage item it names is the one the code uses", () => {
    const entry = read("../src/wallet-entry.ts");
    assert.match(entry, /const KEY = "privacybuddy\.lute"/);
    assert.match(COOKIES, /privacybuddy\.lute/);
    assert.ok(!/sessionStorage|indexedDB/.test(entry + PAGE));
  });

  it("the page loads no outside scripts", () => {
    assert.ok(!/<script[^>]+src="https?:/i.test(PAGE + COOKIES));
  });
});

describe("LICENSE", () => {
  const license = read("../../../LICENSE");

  it("starts with the notice PolyForm requires licensees to keep", () => {
    assert.match(license.split("\n")[0], /^Required Notice: Copyright \(c\) 2026 ChainAim/);
  });

  it("carries the PolyForm Strict text and the ChainAim terms", () => {
    assert.match(license, /# PolyForm Strict License 1\.0\.0/);
    assert.match(license, /other than distributing the software or making changes or new works based on the software/);
    assert.match(license, /No hosting for others/);
    assert.match(license, /packages\/route-engine\//);
    assert.match(license, /trademarks of ChainAim/);
  });
});
