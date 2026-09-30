/**
 * Opt a TestNet account in to USDC (asset 10458941) so it can receive and hold
 * it. Both the payTo account and the buyer need this before a payment. The
 * account's 25 words are read from AVM_MNEMONIC, as in pay.ts, and never
 * printed or saved. The account needs a little TestNet ALGO first (0.3 covers
 * the minimum balance, the opt-in's own 0.1 and the fee). TestNet only.
 *
 *   read -rsp "25 words: " AVM_MNEMONIC && export AVM_MNEMONIC && node scripts/opt-in.ts
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";

const USDC_TESTNET = 10458941n;

const mnemonic = process.env.AVM_MNEMONIC?.trim();
if (!mnemonic) {
  console.error("AVM_MNEMONIC is required: the account's 25 words");
  process.exit(2);
}

const algorand = AlgorandClient.testNet();
const account = algorand.account.fromMnemonic(mnemonic);
const address = account.addr.toString();
console.log(`account ${address}`);

const before = await algorand.account.getInformation(address);
const usdc = before.assets?.find((a) => a.assetId === USDC_TESTNET);
console.log(`ALGO ${Number(before.amount) / 1e6}; USDC ${usdc ? `opted in, balance ${Number(usdc.amount) / 1e6}` : "not opted in"}`);
// process.exitCode, not process.exit(): exiting right after a network call crashes Node on Windows.
if (!usdc && before.amount < 300_000n) {
  console.error("Too little ALGO. Fund this address at https://bank.testnet.algorand.network, then run this again.");
  process.exitCode = 1;
} else if (!usdc) {
  const result = await algorand.send.assetOptIn({ sender: address, assetId: USDC_TESTNET });
  console.log(`opted in to USDC; transaction ${result.txIds[0]}`);
  console.log(`https://lora.algokit.io/testnet/transaction/${result.txIds[0]}`);
}
