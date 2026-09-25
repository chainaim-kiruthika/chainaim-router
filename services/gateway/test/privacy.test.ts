/**
 * Privacy unit tests: entity groups, data classes, masking and restore.
 * All data is synthetic (scripts/synthetic-corpus.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, countTypes } from "../src/privacy/classify.ts";
import { AD_HOC_RECOGNIZERS, DETECTED_ENTITIES, HEALTH_TERMS, isMasked, REQUIRED_PRESIDIO_ENTITIES } from "../src/privacy/entities.ts";

describe("entity groups", () => {
  it("requires the built-in Presidio entities named in V4", () => {
    for (const e of ["IN_AADHAAR", "IN_PAN", "CREDIT_CARD", "US_SSN", "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "MEDICAL_LICENSE"]) {
      assert.ok(REQUIRED_PRESIDIO_ENTITIES.includes(e), e);
    }
  });

  it("never asks Presidio for locations, dates, NRP or URLs", () => {
    for (const e of ["LOCATION", "DATE_TIME", "NRP", "URL"]) assert.ok(!DETECTED_ENTITIES.includes(e), e);
  });

  it("masks personal data and medical IDs, but not cards or health terms", () => {
    assert.equal(isMasked("PERSON"), true);
    assert.equal(isMasked("US_NPI"), true);
    assert.equal(isMasked("CREDIT_CARD"), false);
    assert.equal(isMasked("HEALTH_TERM"), false);
  });

  it("sends MRN, NPI and health-term recognizers; the patterns need a context word", () => {
    const byEntity = new Map(AD_HOC_RECOGNIZERS.map((r) => [r.supported_entity, r]));
    for (const e of ["MEDICAL_RECORD", "US_NPI"]) {
      const r = byEntity.get(e)!;
      assert.ok(r.patterns!.every((p) => p.score < 0.4), `${e} alone stays below the 0.4 threshold`);
      assert.ok(r.context!.length > 0, `${e} has context words`);
    }
    assert.deepEqual(byEntity.get("HEALTH_TERM")!.deny_list, HEALTH_TERMS);
  });

  it("leaves ambiguous abbreviations out of the health terms", () => {
    for (const t of ["AIDS", "STD", "STI"]) assert.ok(!HEALTH_TERMS.includes(t), t);
  });
});

describe("classify", () => {
  type Want = { found: string[]; dataClass: string; dataCollection: string; cardDataRemoved: boolean };
  const cases: [string, string[], boolean, Want][] = [
    ["nothing found", [], false, { found: [], dataClass: "none", dataCollection: "allow", cardDataRemoved: false }],
    ["a name", ["PERSON"], false, { found: ["PII"], dataClass: "PII", dataCollection: "allow", cardDataRemoved: false }],
    ["a general medical question", ["HEALTH_TERM"], false, { found: [], dataClass: "none", dataCollection: "allow", cardDataRemoved: false }],
    ["a name and a condition", ["PERSON", "HEALTH_TERM"], false, { found: ["PHI", "PII"], dataClass: "PHI", dataCollection: "deny", cardDataRemoved: false }],
    ["a medical record number alone", ["MEDICAL_RECORD"], false, { found: ["PHI"], dataClass: "PHI", dataCollection: "deny", cardDataRemoved: false }],
    ["a card", ["CREDIT_CARD"], false, { found: ["PCI"], dataClass: "PCI", dataCollection: "allow", cardDataRemoved: true }],
    ["everything", ["CREDIT_CARD", "PERSON", "US_NPI"], false, { found: ["PHI", "PCI", "PII"], dataClass: "PHI", dataCollection: "deny", cardDataRemoved: true }],
    ["Jev's health flag", ["PERSON"], true, { found: ["PHI", "PII"], dataClass: "PHI", dataCollection: "deny", cardDataRemoved: false }],
  ];
  for (const [name, types, flag, want] of cases) {
    it(name, () => {
      const c = classify(types, flag);
      assert.deepEqual(
        { found: c.found, dataClass: c.dataClass, dataCollection: c.policy.dataCollection, cardDataRemoved: c.policy.cardDataRemoved },
        want,
      );
    });
  }

  it("counts occurrences per type", () => {
    assert.deepEqual(countTypes([{ type: "PERSON" }, { type: "PERSON" }, { type: "HEALTH_TERM" }]), { PERSON: 2, HEALTH_TERM: 1 });
  });
});
