import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserMaskModule, detect } from "../src/mask.ts";

/** The message the page's "Try an example" button fills in. Keep in step with public/index.html. */
export const EXAMPLE = "Name: Rohan Mehta\nEmail: rohan.mehta@example.com\nPhone: +91 98765 43210\nPAN: ABCPM1234K\nAadhaar: 2345 6789 0123\nBank account: 123456789012\nIFSC: ABCD0001234\n\nPlease write a short, polite note asking the applicant to send the last three salary slips for home loan application HL-2041 (INR 12,00,000).";

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
    for (const secret of ["Rohan Mehta", "rohan.mehta@example.com", "98765 43210", "ABCPM1234K", "2345 6789 0123", "123456789012", "ABCD0001234"]) {
      assert.ok(!r.masked.includes(secret), `${secret} is masked`);
    }
  });

  it("the server-side detect finds a raw email and nothing in placeholders", () => {
    assert.ok(detect("write to priya.raman@example.com").length > 0);
    assert.equal(detect("write to <C_EMAIL_ADDRESS_1> and <C_PERSON_1>").length, 0);
  });
});
