/**
 * scripts/client-mask.ts: what is masked on the user's machine, what is left
 * for the model, and that restore puts the values back. Synthetic data only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CARD_REMOVED, detect, maskText, restore } from "../scripts/client-mask.ts";

const PRESCRIPTION = [
  "Apollo Clinic",
  "Patient Name: Jane Roe",
  "Age: 64",
  "Aadhaar 2345 6789 0123, PAN ABCDE1234F",
  "Phone +91 98765 43210, jane.roe@example.com",
  "MRN 991122",
  "Card 4111 1111 1111 1111",
  "Diagnosis: diabetes. Rx: metformin 500 mg twice daily",
  "Dr. Anil Kumar",
  "Question: is Jane Roe taking two drugs for the same thing?",
].join("\n");
const ORIGINALS = ["Jane Roe", "2345 6789 0123", "ABCDE1234F", "+91 98765 43210", "jane.roe@example.com", "991122", "4111 1111 1111 1111", "Anil Kumar"];

describe("client-mask", () => {
  it("leaves no identifier of the prescription in the masked text", () => {
    const { masked } = maskText(PRESCRIPTION);
    for (const v of ORIGINALS) assert.ok(!masked.includes(v), `${v} is still in: ${masked}`);
  });

  it("keeps what the model needs: conditions, drugs, doses and age", () => {
    const { masked } = maskText(PRESCRIPTION);
    for (const v of ["diabetes", "metformin 500 mg twice daily", "Age: 64", "Apollo Clinic"]) assert.ok(masked.includes(v), `${v} was masked: ${masked}`);
  });

  it("uses C_ placeholders, the same one for the same value, and removes cards for good", () => {
    const { masked, map, counts, cardsRemoved } = maskText(PRESCRIPTION);
    assert.ok(masked.includes("Patient Name: <C_PERSON_1>"), masked);
    assert.ok(masked.includes("is <C_PERSON_1> taking"), "the unlabelled second mention of the name is masked too");
    assert.ok(masked.includes("Aadhaar <C_IN_AADHAAR_1>"), masked);
    assert.ok(masked.includes("PAN <C_IN_PAN_1>"), masked);
    assert.ok(masked.includes("MRN <C_MEDICAL_RECORD_1>"), masked);
    assert.ok(masked.includes(`Card ${CARD_REMOVED}`), masked);
    assert.equal(cardsRemoved, 1);
    assert.equal(counts.CREDIT_CARD, 1);
    assert.ok(!Object.values(map).includes("4111 1111 1111 1111"), "a card number is never in the restore map");
    assert.equal(map["<C_PERSON_1>"], "Jane Roe");
  });

  it("restores its own placeholders and leaves the server's alone", () => {
    const { map } = maskText(PRESCRIPTION);
    const r = restore("<C_PERSON_1> should take it with food; < c_in_aadhaar_1 > is on file; <PERSON_1> is the server's; <C_PERSON_9> is unknown.", map);
    assert.equal(r.text, "Jane Roe should take it with food; 2345 6789 0123 is on file; <PERSON_1> is the server's; <C_PERSON_9> is unknown.");
    assert.equal(r.unresolved, 1);
  });

  it("does not mask a number without a context word, or a card that fails the Luhn check", () => {
    assert.deepEqual(detect("Invoice 991122 for 250 rupees"), []);
    assert.deepEqual(detect("Order 4111 1111 1111 1112").filter((f) => f.type === "CREDIT_CARD"), []);
  });

  it("masks a bank account number only next to a label", () => {
    assert.ok(maskText("Account No: 123456789").masked.includes("<C_IN_BANK_ACCOUNT_1>"));
    assert.deepEqual(detect("Balance 123456789").filter((f) => f.type === "IN_BANK_ACCOUNT"), []);
  });

  it("stops a name at the end of the line and at a field label", () => {
    assert.equal(maskText("Patient: Jane Roe\nAge 64").map["<C_PERSON_1>"], "Jane Roe");
    assert.equal(maskText("Patient Jane Roe Age 64").map["<C_PERSON_1>"], "Jane Roe");
    assert.deepEqual(maskText("Patient ID: 12345").map, {});
  });

  it("does not take a drug for a name after 'Drug Name:'", () => {
    assert.ok(maskText("Drug Name: Metformin").masked.includes("Metformin"));
  });

  it("can leave names alone when asked", () => {
    assert.ok(maskText("Patient: Jane Roe", { names: false }).masked.includes("Jane Roe"));
  });
});
