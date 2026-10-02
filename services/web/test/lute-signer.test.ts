import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANCELLED, luteSigner, type WalletTransaction } from "../src/lute-signer.ts";

const A = new Uint8Array([1, 2, 3, 250]);
const B = new Uint8Array([9, 8, 7]);
const SIG = new Uint8Array([42, 42]);

function fakeLute(answer: (txns: WalletTransaction[]) => (Uint8Array | null)[] | Promise<(Uint8Array | null)[]>) {
  const seen: WalletTransaction[][] = [];
  return { seen, signTxns: async (txns: WalletTransaction[]) => (seen.push(txns), answer(txns)) };
}

describe("luteSigner", () => {
  it("keeps the address", () => {
    assert.equal(luteSigner("ADDR", fakeLute(() => []).signTxns).address, "ADDR");
  });

  it("sends each transaction to Lute as base64 of the same bytes", async () => {
    const lute = fakeLute(() => [SIG]);
    await luteSigner("ADDR", lute.signTxns).signTransactions([A]);
    assert.deepEqual(new Uint8Array(Buffer.from(lute.seen[0][0].txn, "base64")), A);
  });

  it("signs only the indexes asked for and marks the rest signers: []", async () => {
    const lute = fakeLute(() => [null, SIG]);
    const out = await luteSigner("ADDR", lute.signTxns).signTransactions([A, B], [1]);
    assert.deepEqual(lute.seen[0][0].signers, []);
    assert.equal(lute.seen[0][1].signers, undefined);
    assert.deepEqual(out, [null, SIG]);
  });

  it("signs everything when no indexes are given", async () => {
    const lute = fakeLute(() => [SIG, SIG]);
    const out = await luteSigner("ADDR", lute.signTxns).signTransactions([A, B]);
    assert.deepEqual(lute.seen[0].map((t) => t.signers), [undefined, undefined]);
    assert.deepEqual(out, [SIG, SIG]);
  });

  it("drops anything Lute returns for a transaction it was not asked to sign", async () => {
    const lute = fakeLute(() => [SIG, SIG]);
    assert.deepEqual(await luteSigner("ADDR", lute.signTxns).signTransactions([A, B], [1]), [null, SIG]);
  });

  it("turns a closed Lute window (code 4100) into the cancelled message", async () => {
    const lute = fakeLute(() => Promise.reject(Object.assign(new Error("User Rejected Request"), { code: 4100 })));
    await assert.rejects(luteSigner("ADDR", lute.signTxns).signTransactions([A]), { message: CANCELLED });
  });

  it("passes any other Lute error on", async () => {
    const lute = fakeLute(() => Promise.reject(Object.assign(new Error("boom"), { code: 4300 })));
    await assert.rejects(luteSigner("ADDR", lute.signTxns).signTransactions([A]), /boom/);
  });

  it("fails clearly when Lute leaves our own transaction unsigned", async () => {
    const lute = fakeLute(() => [null]);
    await assert.rejects(luteSigner("ADDR", lute.signTxns).signTransactions([A]), /Lute did not sign the payment/);
  });
});
