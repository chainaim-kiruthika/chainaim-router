/**
 * Pay for one call to a deployed paywall route: x402, exact scheme, USDC on
 * Algorand. The buyer is the account whose 25-word mnemonic is in
 * AVM_MNEMONIC; use an account other than payTo (self-payments do not count
 * for the challenge). --dry-run shows the price and pays nothing.
 *
 *   node scripts/pay.ts --dry-run https://PAYWALL/v1/privacy/scan '{"text":"..."}'
 *   AVM_MNEMONIC="word1 ... word25" node scripts/pay.ts https://PAYWALL/v1/privacy/scan '{"text":"..."}'
 */
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });
const [url, body = "{}"] = positionals;
if (!url) {
  console.error("usage: node scripts/pay.ts [--dry-run] URL [JSON_BODY]");
  process.exit(2);
}
JSON.parse(body); // fail early on a malformed body
const init = { method: "POST", headers: { "content-type": "application/json" }, body };

if (values["dry-run"]) {
  const r = await fetch(url, init);
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) {
    console.log(`HTTP ${r.status}, no payment asked: ${(await r.text()).slice(0, 300)}`);
    process.exit(r.ok ? 0 : 1);
  }
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  for (const a of required.accepts) {
    console.log(`price ${Number(a.amount) / 1e6} USDC (asset ${a.asset}) on ${a.network} to ${a.payTo}; tag=${a.extra?.tag ?? "none"}`);
  }
  console.log(`resource ${required.resource?.url}; bazaar=${required.extensions?.bazaar ? "yes" : "no"}`);
  process.exit(0);
}

const mnemonic = process.env.AVM_MNEMONIC?.trim();
if (!mnemonic) {
  console.error("AVM_MNEMONIC is required: the buyer account's 25 words");
  process.exit(2);
}
// Loaded only when paying, so --dry-run needs no signing libraries.
const { x402Client, wrapFetchWithPayment, x402HTTPClient } = await import("@x402/fetch");
const { toClientAvmSigner } = await import("@x402/avm");
const { ExactAvmScheme } = await import("@x402/avm/exact/client");
const { seedFromMnemonic } = await import("@algorandfoundation/algokit-utils/algo25");
const { ed25519SigningKeyFromWrappedSecret } = await import("@algorandfoundation/algokit-utils/crypto");

// The signer takes seed + public key, base64, as in the x402 Algorand examples.
const seed = seedFromMnemonic(mnemonic);
const seedCopy = new Uint8Array(seed);
const key = await ed25519SigningKeyFromWrappedSecret({ unwrapEd25519Seed: async () => seed, wrapEd25519Seed: async () => {} });
const signer = toClientAvmSigner(Buffer.concat([Buffer.from(seedCopy), Buffer.from(key.ed25519Pubkey)]).toString("base64"));
const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
console.log(`buyer ${signer.address}`);

const r = await wrapFetchWithPayment(fetch, client)(url, init);
console.log(`HTTP ${r.status}`);
console.log((await r.text()).slice(0, 1000));
if (r.ok) console.log(`payment ${JSON.stringify(new x402HTTPClient(client).getPaymentSettleResponse((name) => r.headers.get(name)))}`);
process.exitCode = r.ok ? 0 : 1;
