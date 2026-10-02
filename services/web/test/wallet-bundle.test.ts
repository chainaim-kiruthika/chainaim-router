import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUNDLE, sourceHash } from "../scripts/build-wallet.ts";

describe("public/wallet.js", () => {
  it("was built from the current source (run npm run build:wallet if this fails)", () => {
    const head = readFileSync(BUNDLE, "utf8").slice(0, 200);
    assert.match(head, new RegExp(`source sha256 ${sourceHash()}`));
  });

  it("exports exactly what the page imports", () => {
    const js = readFileSync(BUNDLE, "utf8");
    const start = js.lastIndexOf("export{");
    assert.ok(start >= 0, "no export clause");
    const clause = js.slice(start + "export{".length, js.indexOf("}", start));
    const names = clause.split(",").map((entry) => entry.trim().split(" as ").pop()!).sort();
    assert.deepEqual(names, ["balance", "connect", "disconnect", "payAndAsk", "savedAccount"]);
  });
});
