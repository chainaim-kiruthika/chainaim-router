import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserMaskModule, detect } from "../src/mask.ts";

/** The message the page's "Try an example" button fills in. Keep in step with public/index.html. */
export const EXAMPLE = "Name: Priya Raman\nEmail: priya.raman@example.com\nPhone: +91 98765 43210\nPAN: AJZPR4821K\n\nPlease write a short, polite email asking my landlord to refund my security deposit of INR 50,000.";

async function load() {
  return import("data:text/javascript;base64," + Buffer.from(browserMaskModule()).toString("base64"));
}

describe("the masking module", () => {
  it("is JavaScript a browser can import, with the functions the page uses", async () => {
    const m = await load();
    for (const name of ["detect", "mask", "maskText", "restore", "CARD_REMOVED", "PREFIX"]) assert.ok(name in m, `${name} is exported`);
  });

  it("masks and restores a sample in the same way the server-side copy does", async () => {
    const m = await load();
    const r = m.maskText(EXAMPLE);
    assert.equal(detect(r.masked).length, 0, "nothing is left to mask");
    assert.equal(m.restore(r.masked, r.map).text, EXAMPLE);
  });

  it("the page's example message is fully masked", async () => {
    const m = await load();
    const r = m.maskText(EXAMPLE);
    for (const secret of ["Priya Raman", "priya.raman@example.com", "98765 43210", "AJZPR4821K"]) {
      assert.ok(!r.masked.includes(secret), `${secret} is masked`);
    }
  });

  it("the server-side detect finds a raw email and nothing in placeholders", () => {
    assert.ok(detect("write to priya.raman@example.com").length > 0);
    assert.equal(detect("write to <C_EMAIL_ADDRESS_1> and <C_PERSON_1>").length, 0);
  });
});
