/**
 * Send TestNet ALGO from one of your accounts to another, to see a successful
 * transaction on lora. This is a plain transfer, not an x402 payment: the
 * paywall only takes USDC. The sender's 25 words are read from AVM_MNEMONIC,
 * as in pay.ts, and never printed or saved. TestNet only.
 *
 *   read -rsp "25 words: " AVM_MNEMONIC && export AVM_MNEMONIC && node scripts/send-algo.ts RECEIVER_ADDRESS [ALGO]
 *
 * ALGO is the amount to send (default 0.1). The sender keeps at least 0.3 ALGO
 * after the transfer: the 0.2 minimum balance with a USDC opt-in, plus the fee.
 */
import { AlgorandClient, decodeAddress, microAlgo } from "@algorandfoundation/algokit-utils";

const [receiver, amountArg = "0.1"] = process.argv.slice(2);
const mnemonic = process.env.AVM_MNEMONIC?.trim();
const amount = Number(amountArg);
const KEEP = 300_000n;

let problem: string | undefined;
if (!receiver) problem = "usage: node scripts/send-algo.ts RECEIVER_ADDRESS [ALGO]";
else if (!mnemonic) problem = "AVM_MNEMONIC is required: the sender's 25 words";
else if (!Number.isFinite(amount) || amount <= 0) problem = `"${amountArg}" is not a positive amount of ALGO`;
else {
  try {
    decodeAddress(receiver);
  } catch {
    problem = "RECEIVER_ADDRESS is not a valid Algorand address (wrong length or checksum)";
  }
}

if (problem) {
  console.error(problem);
  process.exitCode = 2;
} else {
  const algorand = AlgorandClient.testNet();
  const sender = algorand.account.fromMnemonic(mnemonic!);
  const from = sender.addr.toString();
  const micro = BigInt(Math.round(amount * 1e6));
  console.log(`from ${from}\nto   ${receiver}\nsend ${Number(micro) / 1e6} ALGO on TestNet`);

  const info = await algorand.account.getInformation(from);
  console.log(`sender balance ${Number(info.amount) / 1e6} ALGO`);
  // process.exitCode, not process.exit(): exiting right after a network call crashes Node on Windows.
  if (from === receiver) {
    console.error("Sender and receiver are the same account; send to a different one.");
    process.exitCode = 2;
  } else if (info.amount < micro + KEEP) {
    console.error(`Too little ALGO: the sender must keep ${Number(KEEP) / 1e6} ALGO after sending. Send less, or fund it at https://bank.testnet.algorand.network.`);
    process.exitCode = 1;
  } else {
    const result = await algorand.send.payment({ sender: from, receiver, amount: microAlgo(micro), note: "chainaim test transfer" });
    console.log(`sent; transaction ${result.txIds[0]}`);
    console.log(`https://lora.algokit.io/testnet/transaction/${result.txIds[0]}`);
  }
}
