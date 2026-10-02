/**
 * Turns Lute's signTxns into the signer the x402 AVM client expects
 * ({ address, signTransactions }). Lute itself is passed in, so this file has
 * no browser dependency: the tests run it with a fake, and wallet-entry.ts
 * passes the real LuteConnect.
 */
export type WalletTransaction = { txn: string; signers?: string[] };
export type SignTxns = (txns: WalletTransaction[]) => Promise<(Uint8Array | null)[]>;
export type AvmSigner = {
  address: string;
  signTransactions(txns: Uint8Array[], indexesToSign?: number[]): Promise<(Uint8Array | null)[]>;
};

export const CANCELLED = "You cancelled the payment. Nothing was paid.";
export const NOT_SIGNED = "Lute did not sign the payment. Nothing was paid.";

/** Lute's code for a window the user closed or a request they rejected. */
const USER_REJECTED = 4100;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function luteSigner(address: string, signTxns: SignTxns): AvmSigner {
  return {
    address,
    async signTransactions(txns, indexesToSign) {
      const mine = new Set(indexesToSign ?? txns.map((_, i) => i));
      let signed: (Uint8Array | null)[];
      try {
        signed = await signTxns(txns.map((t, i) => (mine.has(i) ? { txn: toBase64(t) } : { txn: toBase64(t), signers: [] })));
      } catch (e) {
        if ((e as { code?: unknown }).code === USER_REJECTED) throw new Error(CANCELLED);
        throw e;
      }
      return txns.map((_, i) => {
        if (!mine.has(i)) return null;
        const s = signed[i];
        if (!s) throw new Error(NOT_SIGNED);
        return s;
      });
    },
  };
}
