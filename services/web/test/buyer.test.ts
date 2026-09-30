import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { createBuyer } from "../src/buyer.ts";

describe("createBuyer", () => {
  const words = mnemonicFromSeed(new Uint8Array(randomBytes(32)));

  it("derives a valid Algorand address from the 25 words, without touching the network", async () => {
    const buyer = await createBuyer(words);
    assert.match(buyer.address, /^[A-Z2-7]{58}$/);
  });

  it("gives the same address for the same words", async () => {
    assert.equal((await createBuyer(words)).address, (await createBuyer(words)).address);
  });

  it("rejects words that are not a valid phrase", async () => {
    await assert.rejects(createBuyer("not a real phrase"));
  });

  it("returns undefined, not an error, for a response with no settlement header", async () => {
    const buyer = await createBuyer(words);
    assert.equal(buyer.settlement(new Response("{}")), undefined);
  });
});
