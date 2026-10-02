/**
 * PrivacyBuddy web: entry point. Configuration comes from the environment; see
 * src/config.ts and README.md. The server holds no wallet key: visitors pay
 * from their own Lute wallet in the browser (public/wallet.js).
 */
import { serve } from "@hono/node-server";
import { createWebApp } from "./app.ts";
import { loadConfig, type WebConfig } from "./config.ts";
import { browserMaskModule } from "./mask.ts";

let config: WebConfig;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`[privacybuddy] ${(e as Error).message}`);
  process.exit(1);
}

const app = createWebApp({
  paywallUrl: config.paywallUrl,
  maskModule: browserMaskModule(),
  pageFile: new URL("../public/index.html", import.meta.url),
  walletFile: new URL("../public/wallet.js", import.meta.url),
  log: (line) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line })),
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[privacybuddy] listening on http://${config.host}:${info.port}  paywall=${config.paywallUrl}  buyers pay with Lute`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
