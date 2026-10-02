import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUNDLE, sourceHash } from "../scripts/build-wallet.ts";

describe("public/wallet.js", () => {
  it("was built from the current source (run npm run build:wallet if this fails)", () => {
    const head = readFileSync(BUNDLE, "utf8").slice(0, 200);
    assert.match(head, new RegExp(`source sha256 ${sourceHash()}`));
  });

  it("exports what the page imports", () => {
    const js = readFileSync(BUNDLE, "utf8");
    for (const name of ["savedAccount", "connect", "disconnect", "balance", "payAndAsk"]) assert.match(js, new RegExp(`\\b${name}\\b`), name);
  });
});
