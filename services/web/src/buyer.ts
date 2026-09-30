/**
 * The demo buyer: an x402 payer built from the 25 words in BUYER_MNEMONIC.
 * The same set-up as scripts/pay.ts and scripts/private-ask.ts. The words are
 * used once to derive the signing key; only the public address leaves this file.
 */
export type Settlement = { success?: boolean; transaction?: string; network?: string };

export type Payer = {
  address: string;
  /** fetch that answers a 402 by signing and sending the payment. */
  fetchPaid: (url: string, init: RequestInit) => Promise<Response>;
  /** The payment receipt from a paid response, if it carries one. */
  settlement: (response: Response) => Settlement | undefined;
};

export async function createBuyer(mnemonic: string): Promise<Payer> {
  const { x402Client, wrapFetchWithPayment, x402HTTPClient } = await import("@x402/fetch");
  const { toClientAvmSigner } = await import("@x402/avm");
  const { ExactAvmScheme } = await import("@x402/avm/exact/client");
  const { seedFromMnemonic } = await import("@algorandfoundation/algokit-utils/algo25");
  const { ed25519SigningKeyFromWrappedSecret } = await import("@algorandfoundation/algokit-utils/crypto");

  const seed = seedFromMnemonic(mnemonic);
  const seedCopy = new Uint8Array(seed);
  const key = await ed25519SigningKeyFromWrappedSecret({ unwrapEd25519Seed: async () => seed, wrapEd25519Seed: async () => {} });
  const signer = toClientAvmSigner(Buffer.concat([Buffer.from(seedCopy), Buffer.from(key.ed25519Pubkey)]).toString("base64"));
  const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
  const paid = wrapFetchWithPayment(fetch, client);
  const http = new x402HTTPClient(client);

  return {
    address: signer.address,
    fetchPaid: (url, init) => paid(url, init),
    settlement: (response) => {
      try {
        return http.getPaymentSettleResponse((name) => response.headers.get(name)) as Settlement | undefined;
      } catch {
        return undefined;
      }
    },
  };
}
