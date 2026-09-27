/**
 * Make a new Algorand account on this machine: its address and 25-word
 * mnemonic, the kind scripts/pay.ts reads from AVM_MNEMONIC. The same account
 * works on TestNet and MainNet. Nothing is saved or sent anywhere: copy the
 * words into a password manager, then clear the terminal.
 *
 *   node scripts/new-account.ts
 */
import { randomBytes } from "node:crypto";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { ed25519SigningKeyFromWrappedSecret } from "@algorandfoundation/algokit-utils/crypto";
import { encodeAddress } from "@algorandfoundation/algokit-utils";

const seed = new Uint8Array(randomBytes(32));
const words = mnemonicFromSeed(new Uint8Array(seed));
const key = await ed25519SigningKeyFromWrappedSecret({ unwrapEd25519Seed: async () => seed, wrapEd25519Seed: async () => {} });

console.log(`address ${encodeAddress(key.ed25519Pubkey)}`);
console.log("25 words (save them in a password manager, then clear this terminal):");
console.log(words);
