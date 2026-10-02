/**
 * Vercel entry for PrivacyBuddy's API routes (/api/wallets and /api/chat). On
 * Vercel the page, wallet.js and client-mask.js are static files, so this
 * function only ever sees /api/* requests; it runs the same Hono app as
 * src/main.ts. scripts/build-vercel.ts bundles it. PAYWALL_URL comes from the
 * Vercel project's environment variables.
 */
import { getRequestListener } from "@hono/node-server";
import { createWebApp } from "./app.ts";
import { loadConfig } from "./config.ts";

function createFetch(): (request: Request) => Response | Promise<Response> {
  let paywallUrl: string;
  try {
    paywallUrl = loadConfig(process.env).paywallUrl;
  } catch (e) {
    // A missing or bad PAYWALL_URL answers every request with the reason instead of crashing the function.
    const message = (e as Error).message;
    console.error(`[privacybuddy] ${message}`);
    return () => Response.json({ error: { message: `This deployment is not configured: ${message}` } }, { status: 500 });
  }
  const app = createWebApp({
    paywallUrl,
    // Served as static files on Vercel, never by this function.
    maskModule: "",
    pageFile: new URL("../public/index.html", import.meta.url),
    walletFile: new URL("../public/wallet.js", import.meta.url),
    log: (line) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line })),
  });
  return app.fetch;
}

export default getRequestListener(createFetch());
