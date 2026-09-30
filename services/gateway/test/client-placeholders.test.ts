/**
 * Text masked on the user's machine (services/paywall/scripts/client-mask.ts)
 * must keep the protection it would have had unmasked: a masked name next to
 * a condition, or a masked medical record number, is still health data.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, clientPlaceholderTypes } from "../src/privacy/classify.ts";

describe("client placeholders", () => {
  it("reads <C_TYPE_n> in any case and spacing, and [CARD REMOVED] as a card; ignores the server's own <TYPE_n>", () => {
    assert.deepEqual(
      clientPlaceholderTypes(["Patient <C_PERSON_1>, MRN <C_MEDICAL_RECORD_1>, seen by <PERSON_1>", "Card [CARD REMOVED], PAN < c_in_pan_2 >"]),
      ["PERSON", "MEDICAL_RECORD", "IN_PAN", "CREDIT_CARD"],
    );
    assert.deepEqual(clientPlaceholderTypes(["no placeholders here", "<PERSON_1> is the server's"]), []);
  });

  it("keeps a client-masked prescription PHI, so it only goes to providers that do not collect data", () => {
    // What Presidio finds in "Patient <C_PERSON_1> ... diabetes, metformin": health terms only.
    const presidio = ["HEALTH_TERM", "HEALTH_TERM"];
    assert.equal(classify(presidio).policy.dataCollection, "allow", "without the client placeholders the policy would loosen");
    const c = classify([...presidio, ...clientPlaceholderTypes(["Patient <C_PERSON_1> has diabetes and takes metformin"])]);
    assert.equal(c.dataClass, "PHI");
    assert.equal(c.policy.dataCollection, "deny");
  });

  it("treats a masked medical record number alone as PHI, and a removed card as PCI", () => {
    assert.equal(classify(clientPlaceholderTypes(["MRN <C_MEDICAL_RECORD_1>"])).dataClass, "PHI");
    const card = classify(clientPlaceholderTypes(["Card [CARD REMOVED]"]));
    assert.deepEqual(card.found, ["PCI"]);
    assert.equal(card.policy.cardDataRemoved, true);
  });
});
