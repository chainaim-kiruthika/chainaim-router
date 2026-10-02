/**
 * PrivacyBuddy web: entry point. Configuration comes from the environment; see
 * src/config.ts and README.md. BUYER_MNEMONIC is optional: without it the page
 * works up to the Execute step, which then says the buyer wallet is not set up.
 */
import { serve } from "@hono/node-server";
import { createWebApp } from "./app.ts";
import { createBuyer, type Payer } from "./buyer.ts";
import { loadConfig, type WebConfig } from "./config.ts";
import { browserMaskModule } from "./mask.ts";

let config: WebConfig;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`[privacybuddy] ${(e as Error).message}`);
  process.exit(1);
}

// Read the words once, then take them out of the environment so nothing started later can see them.
const mnemonic = process.env.BUYER_MNEMONIC?.trim();
delete process.env.BUYER_MNEMONIC;
let buyer: Payer | undefined;
if (mnemonic) {
  try {
    buyer = await createBuyer(mnemonic);
  } catch {
    console.error("[privacybuddy] BUYER_MNEMONIC is not a valid 25-word Algorand phrase");
    process.exit(1);
  }
}

const app = createWebApp({
  paywallUrl: config.paywallUrl,
  ratePerMinute: config.ratePerMinute,
  maxExecutesPerHour: config.maxExecutesPerHour,
  buyer,
  maskModule: browserMaskModule(),
  pageFile: new URL("../public/index.html", import.meta.url),
  walletFile: new URL("../public/wallet.js", import.meta.url),
  log: (line) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line })),
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[privacybuddy] listening on http://${config.host}:${info.port}  paywall=${config.paywallUrl}  buyer=${buyer ? buyer.address : "not set (Execute is off)"}`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
