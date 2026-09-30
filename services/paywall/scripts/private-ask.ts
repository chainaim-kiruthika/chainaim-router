/**
 * Ask ChainAim about a document without sending its identifiers. The file is
 * read and masked on this machine (scripts/client-mask.ts); only the masked
 * text is paid for and sent; placeholders in the answer are put back here.
 * ChainAim's server scans the masked text again. The restore map never
 * leaves this process and is never written to disk.
 *
 *   node scripts/private-ask.ts --file prescription.txt --dry-run
 *   AVM_MNEMONIC="word1 ... word25" node scripts/private-ask.ts --file prescription.txt --url https://PAYWALL [--endpoint chat|scan|mask]
 *
 * --endpoint      chat (default), scan or mask
 * --question      what to ask about the document (chat only)
 * --max-tokens    longest answer, 1 to 1024 (chat only, default 512)
 * --dry-run       mask and show what would be sent; send and pay nothing
 * --keep-masked   show the answer with the placeholders left in
 * --no-names      do not mask names found after a label
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { detect, maskText, restore } from "./client-mask.ts";

const PATHS = { chat: "/v1/chat/completions", scan: "/v1/privacy/scan", mask: "/v1/privacy/mask" } as const;
type Endpoint = keyof typeof PATHS;
/** The gateway's limits: 48,000 characters of chat text; 20,000 for scan and mask. */
const LIMITS: Record<Endpoint, number> = { chat: 48_000, scan: 20_000, mask: 20_000 };
const TEXT_FILES = new Set([".txt", ".md", ".text"]);

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    url: { type: "string" },
    endpoint: { type: "string", default: "chat" },
    question: { type: "string", default: "Explain this document in plain language: what each item means, and anything I should ask about." },
    "max-tokens": { type: "string", default: "512" },
    "dry-run": { type: "boolean", default: false },
    "keep-masked": { type: "boolean", default: false },
    "no-names": { type: "boolean", default: false },
  },
});

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

const file = values.file ?? fail(2, "usage: node scripts/private-ask.ts --file DOCUMENT.txt [--url https://PAYWALL] [--endpoint chat|scan|mask] [--dry-run]");
if (!TEXT_FILES.has(extname(file).toLowerCase())) fail(2, `${file}: only .txt and .md files for now; save the PDF or Word file as plain text first`);
const endpoint = values.endpoint as Endpoint;
if (!Object.hasOwn(PATHS, endpoint)) fail(2, "--endpoint must be chat, scan or mask");
const maxTokens = Number(values["max-tokens"]);
if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024) fail(2, "--max-tokens must be a whole number from 1 to 1024");
const dryRun = values["dry-run"] === true;
const base = values.url?.replace(/\/+$/, "");
if (!dryRun && (!base || !/^https?:\/\//.test(base) || !URL.canParse(base))) fail(2, "--url is required and must be the paywall's http(s) address, e.g. https://PAYWALL");

let document: string;
try {
  document = readFileSync(file, "utf8");
} catch (e) {
  fail(2, `cannot read ${file}: ${(e as Error).message}`);
}
if (document.trim() === "") fail(2, `${file} is empty`);

// The question is masked together with the document: a name typed in it is a name too.
const content = endpoint === "chat" ? `${values.question}\n\n--- document ---\n${document}` : document;
const options = { names: values["no-names"] !== true };
const { masked, map, counts, cardsRemoved } = maskText(content, options);

// Self-check before anything leaves: the masked text must hold nothing this file would mask again.
if (detect(masked, options).length > 0) fail(1, "refusing to send: the masked text still holds a value that should be masked; nothing was sent");
if (masked.length > LIMITS[endpoint]) fail(2, `the text is ${masked.length} characters after masking; ${endpoint} takes at most ${LIMITS[endpoint]}; nothing was sent`);

const body = endpoint === "chat" ? { model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens } : { text: masked };
const bodyText = JSON.stringify(body);
const summary = Object.entries(counts).map(([type, n]) => `${n} ${type}`).join(", ");

console.log(`read ${file} on this computer: ${document.length} characters`);
console.log(`masked on this computer: ${summary || "nothing found"}${cardsRemoved > 0 ? ` (card numbers removed for good: ${cardsRemoved})` : ""}`);
console.log("--- what leaves this computer (masked) ---");
console.log(masked);
console.log("--- end ---");

if (dryRun) {
  console.log(`request body: ${bodyText}`);
  console.log("dry run: nothing was sent and nothing was paid");
  process.exit(0);
}

const mnemonic = process.env.AVM_MNEMONIC?.trim() || fail(2, "AVM_MNEMONIC is required: the buyer account's 25 words");
// Loaded only when paying, so --dry-run needs no signing libraries. Same signer set-up as scripts/pay.ts.
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

const url = `${base}${PATHS[endpoint]}`;
console.log(`buyer ${signer.address}; sending ${bodyText.length} bytes to ${url}`);
const r = await wrapFetchWithPayment(fetch, client)(url, { method: "POST", headers: { "content-type": "application/json" }, body: bodyText });
console.log(`HTTP ${r.status}`);
r.headers.forEach((value, name) => {
  if (name.startsWith("x-chainaim-")) console.log(`${name}: ${value}`);
});
const raw = await r.text();
if (!r.ok) {
  console.log(raw.slice(0, 1000));
  process.exit(1);
}

let answer: any;
try {
  answer = JSON.parse(raw);
} catch {
  answer = undefined;
}
if (endpoint === "chat") {
  const text = answer?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    console.log(raw.slice(0, 1000));
  } else {
    const shown = values["keep-masked"] ? { text, unresolved: 0 } : restore(text, map);
    console.log(values["keep-masked"] ? "--- answer (placeholders kept) ---" : "--- answer (names put back on this computer) ---");
    console.log(shown.text);
    console.log("--- end ---");
    if (shown.unresolved > 0) console.log(`${shown.unresolved} placeholder(s) in the answer were not ones this computer made, so they were left as they are`);
  }
} else {
  console.log(`--- ChainAim server's ${endpoint} of the masked text ---`);
  console.log(answer === undefined ? raw.slice(0, 1000) : JSON.stringify(answer, null, 2));
}
console.log(`payment ${JSON.stringify(new x402HTTPClient(client).getPaymentSettleResponse((name) => r.headers.get(name)))}`);
