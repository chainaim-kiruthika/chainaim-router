/**
 * chainaim-paywall entry point. Configuration comes from the environment;
 * see src/config.ts and docs/deploy/railway.md.
 */
import { serve } from "@hono/node-server";
import { createPaywall } from "./app.ts";
import { loadConfig, type PaywallConfig } from "./config.ts";

let config: PaywallConfig;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`[chainaim-paywall] ${(e as Error).message}`);
  process.exit(1);
}

const server = serve({ fetch: createPaywall(config).fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(
    `[chainaim-paywall] listening on ${config.host}:${info.port}  network=${config.networkName} payTo=${config.payTo} ` +
      `gateway=${config.gatewayUrl} facilitator=${config.facilitatorUrl}${config.publicBaseUrl ? ` public=${config.publicBaseUrl}` : ""}`,
  );
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
