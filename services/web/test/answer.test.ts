import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAnswer } from "../src/answer.ts";

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
const answerText = JSON.stringify({ choices: [{ message: { content: "Hi <C_PERSON_1>" } }] });

describe("readAnswer", () => {
  it("reads the answer, model, data class and receipt", () => {
    assert.deepEqual(readAnswer(200, answerText, headers({ "x-chainaim-model": "m:free", "x-chainaim-data-class": "PII" }), { transaction: "TX1", network: "algorand:x" }), {
      answer: "Hi <C_PERSON_1>",
      model: "m:free",
      dataClass: "PII",
      payment: { transaction: "TX1", network: "algorand:x" },
    });
  });

  it("still answers when there is no receipt", () => {
    const a = readAnswer(200, answerText, headers({}), undefined);
    assert.deepEqual("payment" in a && a.payment, { transaction: null, network: null });
  });

  it("explains a payment that was not accepted", () => {
    assert.deepEqual(readAnswer(402, "{}", headers({}), undefined), {
      error: "The payment was not accepted. Check that your wallet holds TestNet USDC and has opted in to it. You were not charged.",
      status: 402,
    });
  });

  it("passes the service's own message on, cut to 300 characters", () => {
    const r = readAnswer(503, JSON.stringify({ error: { message: "every model tried failed; you were not charged" } }), headers({}), undefined);
    assert.deepEqual(r, { error: "every model tried failed; you were not charged", status: 503 });
    const long = readAnswer(400, JSON.stringify({ error: { message: "x".repeat(400) } }), headers({}), undefined);
    assert.equal("error" in long && long.error.length, 300);
  });

  it("gives a generic message when the failure has no readable message", () => {
    assert.deepEqual(readAnswer(500, "<html>", headers({}), undefined), { error: "The chat service failed (HTTP 500). You were not charged.", status: 500 });
  });

  it("does not hand on an answer it cannot read", () => {
    assert.deepEqual(readAnswer(200, "{}", headers({}), { transaction: "TX1" }), {
      error: "The model's answer could not be read. Check the payment receipt before trying again.",
      status: 502,
    });
  });
});
