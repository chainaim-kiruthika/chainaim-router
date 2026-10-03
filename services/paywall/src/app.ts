/**
 * chainaim-paywall: the only public service (spec section 9). It asks for
 * payment (x402, exact scheme, USDC on Algorand through the GoPlausible
 * facilitator), then proxies the call to the private gateway with the
 * gateway key. Payment headers are never forwarded, so the gateway cannot
 * learn who paid.
 *
 * Order matters: the body limit and the capacity guard run before the
 * payment middleware, so nobody is asked to pay for a call that cannot be
 * served. The middleware settles only responses below 400, so every refusal
 * is free for the caller.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension } from "@x402-avm/extensions";
import type { PaywallConfig } from "./config.ts";
import { paymentKey, ReplayGuard } from "./replay.ts";
import { PAID_ROUTES, routesConfig } from "./routes.ts";

/** The same limit as the gateway's default --max-body-bytes. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Gateway response headers passed back to the caller; everything else is dropped. */
const PASS_BACK = /^(content-type|retry-after|x-chainaim-[a-z-]+)$/;

export type PaywallDeps = { log?: (line: string) => void; now?: () => number; maxReplayEntries?: number };

const SITE_NAME = "PrivacyBuddy";
const OWNER = "ChainAim";
const SITE_DESCRIPTION = "Private AI chat. Sensitive details are masked before any model sees them, and every answer is paid per call in USDC on Algorand with x402.";

/**
 * The root page. The facilitator's Bazaar names a merchant from the HTML at the
 * root of its domain (og:site_name, then og:title, then the title), so this
 * page is what the leaderboard shows. No og:image: no logo was chosen. The
 * trademark sign goes only in the visible body: the title and og tags stay the
 * plain name, so the listing is not renamed.
 */
const ROOT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_NAME}</title>
<meta name="description" content="${SITE_DESCRIPTION}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${SITE_NAME}">
<meta property="og:description" content="${SITE_DESCRIPTION}">
</head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<h1>${SITE_NAME}™</h1>
<p>${SITE_DESCRIPTION}</p>
<p>This address is the paywall API. <a href="https://chainaim-router.vercel.app">Try it in the browser</a> · <a href="https://github.com/chainaimdev/chainaim-router">Source code</a></p>
<p style="font-size: clamp(.78rem, 2.4vw, .85rem); opacity: .7">© 2026 ${OWNER}. ${SITE_NAME}™ is a trademark of ${OWNER}. All rights reserved. Source-available, not open source: <a href="https://github.com/chainaimdev/chainaim-router/blob/main/LICENSE">License</a></p>
</body>
</html>
`;

function errorBody(c: Context, status: 404 | 413 | 502 | 503, message: string, headers: Record<string, string> = {}): Response {
  return c.json({ error: { message, type: status >= 500 ? "gateway_error" : "invalid_request_error", code: status } }, status, headers);
}

export function createPaywall(config: PaywallConfig, deps: PaywallDeps = {}): Hono {
  const log = deps.log ?? ((line: string) => console.log(line));
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl })).register(config.network, new ExactAvmScheme());
  server.registerExtension(bazaarResourceServerExtension as never);
  // A payment is accepted once: a refused call is never settled, so nothing else stops a replay from draining the free-model quota.
  const replays = new ReplayGuard(deps.now, deps.maxReplayEntries);
  server.onBeforeVerify(async (ctx) => {
    if (replays.claim(paymentKey(ctx.paymentPayload.payload))) return;
    return { abort: true, reason: "payment_already_used", message: "this payment was already presented; sign a new one" };
  });
  // Payment log: one line per settled payment; never a decision id or a body.
  server.onAfterSettle(async (ctx) => {
    const request = (ctx.transportContext as { request?: { method?: string; path?: string } } | undefined)?.request;
    log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "payment_settled",
        route: `${request?.method ?? "?"} ${request?.path ?? "?"}`,
        amount: ctx.requirements.amount,
        asset: ctx.requirements.asset,
        network: ctx.result.network,
        payer: ctx.result.payer ?? null,
        transaction: ctx.result.transaction,
      }),
    );
  });

  /**
   * Forward the method, path, content type and body; pass back the status,
   * body and allowed headers. A caller who hangs up cancels the gateway call,
   * so the answer is a 502 and nothing is settled.
   */
  async function proxy(c: Context): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.gatewayKey}` };
    const type = c.req.header("content-type");
    if (type) headers["content-type"] = type;
    const signal = AbortSignal.any([AbortSignal.timeout(config.gatewayTimeoutMs), c.req.raw.signal]);
    const init: RequestInit = { method: c.req.method, headers, signal };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") init.body = await c.req.arrayBuffer();
    let upstream: Response;
    try {
      upstream = await fetch(`${config.gatewayUrl}${c.req.path}`, init);
    } catch {
      return errorBody(c, 502, "the gateway did not answer; you were not charged");
    }
    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (PASS_BACK.test(name)) out.set(name, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  const app = new Hono();
  app.use(bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => errorBody(c, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`) }));

  // Capacity guard: no price is shown for a chat call that cannot be served now.
  app.use("/v1/chat/completions", async (c, next) => {
    if (c.req.method !== "POST") return next();
    let capacity: { chatAvailable?: unknown; reason?: unknown; retryAfterSec?: unknown };
    try {
      const r = await fetch(`${config.gatewayUrl}/internal/capacity`, {
        headers: { authorization: `Bearer ${config.gatewayKey}` },
        signal: AbortSignal.timeout(5000),
      });
      capacity = r.ok ? await r.json() : { reason: `gateway HTTP ${r.status}` };
    } catch {
      capacity = { reason: "gateway unreachable" };
    }
    if (capacity.chatAvailable === true) return next();
    const retryAfter = typeof capacity.retryAfterSec === "number" && capacity.retryAfterSec > 0 ? String(Math.ceil(capacity.retryAfterSec)) : "60";
    const reason = typeof capacity.reason === "string" ? capacity.reason : "no capacity";
    return errorBody(c, 503, `chat is unavailable right now (${reason}); you were not charged`, { "retry-after": retryAfter });
  });

  app.use(paymentMiddleware(routesConfig(config), server));

  for (const route of PAID_ROUTES) app.post(route.path, proxy);
  app.get("/", (c) => c.html(ROOT_PAGE));
  app.get("/v1/models", proxy);
  app.get("/healthz", proxy);
  app.notFound((c) => errorBody(c, 404, `no route for ${c.req.method} ${c.req.path}`));
  return app;
}
