/**
 * Privacy unit tests: entity groups, data classes, masking and restore.
 * All data is synthetic (scripts/synthetic-corpus.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, countTypes } from "../src/privacy/classify.ts";
import { AD_HOC_RECOGNIZERS, DETECTED_ENTITIES, HEALTH_TERMS, isMasked, REQUIRED_PRESIDIO_ENTITIES } from "../src/privacy/entities.ts";
import { CORPUS, KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { stubDetect } from "../../../scripts/stub-presidio.ts";
import { mapConversation, Masker, withinValue } from "../src/privacy/mask.ts";
import { postProcess } from "../src/privacy/presidio.ts";
import { restoreCompletion, restoreText } from "../src/privacy/restore.ts";
import { leaked, withCardsRemoved } from "./helpers.ts";

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

/** What PresidioClient.analyze would return for `text` against the stub. */
function detect(text: string) {
  const found = stubDetect(text, HEALTH_TERMS).map((f) => ({ type: f.entity_type, start: f.start, end: f.end, score: f.score }));
  return postProcess(text, found);
}

describe("Masker", () => {
  it("numbers each type from 1, reuses a placeholder for the same value and keeps health terms", () => {
    const text = "Jane Roe met Maria Garcia; later Jane Roe emailed jane.roe@example.com about asthma.";
    const m = new Masker();
    assert.equal(m.mask(text, detect(text)), "<PERSON_1> met <PERSON_2>; later <PERSON_1> emailed <EMAIL_ADDRESS_1> about asthma.");
    assert.deepEqual(m.map, { "<PERSON_1>": "Jane Roe", "<PERSON_2>": "Maria Garcia", "<EMAIL_ADDRESS_1>": "jane.roe@example.com" });
  });

  it("shares numbering across texts in reading order", () => {
    const m = new Masker();
    assert.equal(m.mask("Hi Tom Baker", detect("Hi Tom Baker")), "Hi <PERSON_1>");
    assert.equal(m.mask("Tom Baker and Alan Grant", detect("Tom Baker and Alan Grant")), "<PERSON_1> and <PERSON_2>");
  });

  it("compares emails ignoring case", () => {
    const m = new Masker();
    const spans = [
      { type: "EMAIL_ADDRESS", start: 0, end: 20, score: 1 },
      { type: "EMAIL_ADDRESS", start: 25, end: 45, score: 1 },
    ];
    assert.equal(m.mask("jane.roe@example.com and JANE.ROE@EXAMPLE.COM", spans), "<EMAIL_ADDRESS_1> and <EMAIL_ADDRESS_1>");
  });

  it("removes cards for good: no placeholder, not in the map", () => {
    const text = "Card 4111 1111 1111 1111 was charged $42 for Arjun Mehta.";
    const m = new Masker();
    assert.equal(m.mask(text, detect(text)), "Card [CARD REMOVED] was charged $42 for <PERSON_1>.");
    assert.equal(m.cardsRemoved, 1);
    assert.deepEqual(m.map, { "<PERSON_1>": "Arjun Mehta" });
  });
});

describe("restore", () => {
  it("restores placeholders in any case, with spaces inside the brackets", () => {
    const stats = { unresolved: 0 };
    assert.equal(restoreText("Dear < person_1 >, see <PERSON_1>.", { "<PERSON_1>": "Jane Roe" }, stats), "Dear Jane Roe, see Jane Roe.");
    assert.equal(stats.unresolved, 0);
  });

  it("leaves an unknown placeholder alone and counts it", () => {
    const stats = { unresolved: 0 };
    assert.equal(restoreText("Hi <PERSON_9>", { "<PERSON_1>": "Jane Roe" }, stats), "Hi <PERSON_9>");
    assert.equal(stats.unresolved, 1);
  });

  it("JSON-escapes values inside tool-call arguments", () => {
    const map = { "<PERSON_1>": 'Jane "JR" Roe', "<MEDICAL_RECORD_1>": "C:\\records\\991122" };
    const args = restoreText('{"who":"<PERSON_1>","path":"<MEDICAL_RECORD_1>"}', map, { unresolved: 0 }, true);
    assert.deepEqual(JSON.parse(args), { who: 'Jane "JR" Roe', path: "C:\\records\\991122" });
  });

  it("restores content, reasoning, refusal and tool-call arguments of every choice", () => {
    const completion = {
      choices: [
        {
          message: {
            content: "Hello <PERSON_1>",
            reasoning: "<PERSON_1> asked",
            refusal: "not for <PERSON_1>",
            tool_calls: [{ function: { name: "lookup", arguments: '{"q":"<PERSON_1>"}' } }],
          },
        },
      ],
    };
    const stats = { unresolved: 0 };
    restoreCompletion(completion, { "<PERSON_1>": 'Jane "JR" Roe' }, stats);
    const m = completion.choices[0].message;
    assert.equal(m.content, 'Hello Jane "JR" Roe');
    assert.equal(m.reasoning, 'Jane "JR" Roe asked');
    assert.equal(m.refusal, 'not for Jane "JR" Roe');
    assert.deepEqual(JSON.parse(m.tool_calls[0].function.arguments), { q: 'Jane "JR" Roe' });
  });

  describe("launch gate 2: masking then restoring returns the original text", () => {
    for (const item of CORPUS) {
      it(item.id, () => {
        const m = new Masker();
        const masked = m.mask(item.text, detect(item.text));
        for (const { value } of KNOWN_VALUES) assert.ok(!masked.includes(value), `${value} is still in the masked text`);
        assert.equal(restoreText(masked, m.map, { unresolved: 0 }), withCardsRemoved(item.text));
      });
    }
  });
});

describe("conversation masking", () => {
  it("visits every text field in reading order, with the JSON key as context", () => {
    const seen: [string, string][] = [];
    mapConversation(
      [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "open", arguments: '{"patient":"Jane Roe","ids":[991122],"note":{"mrn":"991122"}}' } }] },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ],
      (text, context) => {
        seen.push([context, text]);
        return text;
      },
    );
    assert.deepEqual(seen, [["", "Be brief."], ["", "part one"], ["", "part two"], ["patient: ", "Jane Roe"], ["ids: ", "991122"], ["mrn: ", "991122"], ["", "done"]]);
  });

  it("keeps only role, content, tool_calls and tool_call_id", () => {
    const [m] = mapConversation([{ role: "user", content: "hi", name: "jane_roe", reasoning: "secret" } as never], (t) => t);
    assert.deepEqual(m, { role: "user", content: "hi" });
  });

  it("re-serializes JSON arguments and scans other arguments whole", () => {
    const out = mapConversation(
      [
        {
          role: "assistant",
          tool_calls: [
            { type: "function", function: { name: "a", arguments: '{ "q" : "Tom Baker" }' } },
            { type: "function", function: { name: "b", arguments: "not json: Tom Baker" } },
          ],
        },
      ],
      (t) => t.replaceAll("Tom Baker", "<PERSON_1>"),
    );
    assert.deepEqual(out[0].tool_calls!.map((c) => c.function.arguments), ['{"q":"<PERSON_1>"}', "not json: <PERSON_1>"]);
  });

  it("keeps a number with nothing to mask, and turns a masked number into a string", () => {
    const out = mapConversation([{ role: "assistant", tool_calls: [{ type: "function", function: { name: "a", arguments: '{"n":42,"mrn":991122}' } }] }], (t) =>
      t.replaceAll("991122", "<MEDICAL_RECORD_1>"),
    );
    assert.equal(out[0].tool_calls![0].function.arguments, '{"n":42,"mrn":"<MEDICAL_RECORD_1>"}');
  });

  it("withinValue drops spans inside the context and moves the others onto the value", () => {
    // analysed text "mrn: 991122": "mrn" (0..3) is context only; 991122 is at 5..11
    const found = [
      { type: "PERSON", start: 0, end: 3, score: 0.9 },
      { type: "MEDICAL_RECORD", start: 5, end: 11, score: 0.45 },
    ];
    assert.deepEqual(withinValue("991122", found, 5), [{ type: "MEDICAL_RECORD", start: 0, end: 6, score: 0.45 }]);
    assert.deepEqual(withinValue("991122", [{ type: "PERSON", start: 3, end: 8, score: 0.9 }], 5), [{ type: "PERSON", start: 0, end: 3, score: 0.9 }]);
  });

  it("launch gate 2 for tool-call arguments: masking then restoring gives the same JSON", () => {
    const args = JSON.stringify({ patient: 'Jane "JR" Roe', file: "C:\\records\\991122.txt" });
    const masker = new Masker();
    const [m] = mapConversation([{ role: "assistant", tool_calls: [{ type: "function", function: { name: "open", arguments: args } }] }], (text, context) =>
      masker.mask(text, withinValue(text, detect(context + text), context.length)),
    );
    const masked = m.tool_calls![0].function.arguments;
    assert.deepEqual(leaked(masked), [], "no identifier in the arguments, raw or JSON-escaped");
    assert.equal(restoreText(masked, masker.map, { unresolved: 0 }, true), args);
  });
});
