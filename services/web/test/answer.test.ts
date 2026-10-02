import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAnswer } from "../src/answer.ts";

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
/** The Payment-Required header of a 402, as the paywall sends it: base64 JSON with the reason in `error`. */
const requiredHeader = (error: string) => headers({ "payment-required": b64({ x402Version: 2, error, accepts: [] }) });
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

  it("explains a payment that was not accepted, without naming a network it does not know", () => {
    assert.deepEqual(readAnswer(402, "{}", headers({}), undefined), {
      error: "The payment was not accepted. Check that your wallet holds USDC and has opted in to it. You were not charged.",
      status: 402,
    });
  });

  it("names the network the payment was for", () => {
    assert.match((readAnswer(402, "{}", headers({}), undefined, "mainnet") as { error: string }).error, /holds USDC on MainNet and has opted in/);
    assert.match((readAnswer(402, "{}", headers({}), undefined, "testnet") as { error: string }).error, /holds USDC on TestNet and has opted in/);
  });

  it("gives the paywall's own reason for refusing the payment", () => {
    assert.deepEqual(readAnswer(402, "{}", requiredHeader("this payment was already presented; sign a new one"), undefined, "mainnet"), {
      error: "The payment was not accepted (this payment was already presented; sign a new one). Check that your wallet holds USDC on MainNet and has opted in to it. You were not charged.",
      status: 402,
    });
  });

  it("cuts a long reason, strips control characters, and ignores one that is not text", () => {
    const long = readAnswer(402, "{}", requiredHeader("x".repeat(400)), undefined) as { error: string };
    assert.ok(long.error.startsWith(`The payment was not accepted (${"x".repeat(120)}).`));
    assert.doesNotMatch((readAnswer(402, "{}", requiredHeader("bad\nreason\u0000"), undefined) as { error: string }).error, /[\u0000-\u001f]/);
    assert.match((readAnswer(402, "{}", headers({ "payment-required": b64({ error: { nested: true } }) }), undefined) as { error: string }).error, /^The payment was not accepted\. Check/);
  });

  it("leaves the reason out when the paywall only asked for payment or the header cannot be read", () => {
    for (const h of [requiredHeader("Payment required"), requiredHeader(""), headers({ "payment-required": "not base64 json" })]) {
      assert.match((readAnswer(402, "{}", h, undefined) as { error: string }).error, /^The payment was not accepted\. Check/);
    }
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

  it("does not hand on an answer it cannot read, but keeps the receipt", () => {
    assert.deepEqual(readAnswer(200, "{}", headers({}), { transaction: "TX1" }), {
      error: "The model's answer could not be read. Check the payment receipt before trying again.",
      status: 502,
      transaction: "TX1",
    });
    assert.equal((readAnswer(200, "{}", headers({}), undefined) as { transaction?: unknown }).transaction, null);
  });
});
