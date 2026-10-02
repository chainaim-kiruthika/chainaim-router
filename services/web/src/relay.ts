/**
 * POST /api/chat: the browser's paid chat call, relayed to the paywall. The
 * browser runs the x402 client and the visitor's Lute wallet signs; this route
 * only checks that the request is this page's request with nothing left to
 * mask, then passes the x402 exchange through unchanged. It holds no key, and
 * it logs neither the text nor the payment.
 */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { detect } from "./mask.ts";

const CHAT = "/v1/chat/completions";
/** The gateway's chat limit, in characters of message text. */
export const MAX_MASKED_CHARS = 48_000;
/**
 * The paywall's own 200 s gateway timeout, plus margin for its capacity check,
 * payment verify and on-chain settle, which all happen inside this one call.
 */
const RELAY_TIMEOUT_MS = 240_000;
/** A chat request is at most 48,000 characters of text plus a little JSON. */
const MAX_BODY_BYTES = 256 * 1024;
/** A signed payment group is a few KB; anything far larger is not ours. */
const MAX_SIGNATURE_CHARS = 65_536;
/** Response headers the page needs; nothing else from the paywall is passed on. */
const PASS_BACK = ["payment-required", "payment-response", "x-chainaim-model", "x-chainaim-data-class"];

export type ChatBody = { model: "chainaim/auto"; messages: [{ role: "user"; content: string }]; max_tokens: number };

type RelayCtx = {
  paywallUrl: string;
  fetcher: typeof fetch;
  now: () => number;
  /** Status, sizes and timing only. Never text, placeholders, the map or the payment. */
  log: (line: Record<string, unknown>) => void;
};

const fail = (c: Context, status: 400 | 413 | 502, message: string) => c.json({ error: { message } }, status);

/** The validated request, rebuilt from known fields only, or the reason it was refused. */
export function checkChat(body: unknown): ChatBody | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "The request must be a JSON object.";
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !["model", "messages", "max_tokens"].includes(k));
  if (extra !== undefined) return `Unexpected field: ${extra.slice(0, 40)}.`;
  if (b.model !== "chainaim/auto") return 'model must be "chainaim/auto".';
  const m = b.messages;
  const first = Array.isArray(m) && m.length === 1 ? (m[0] as Record<string, unknown> | null) : null;
  if (!first || typeof first !== "object" || first.role !== "user" || typeof first.content !== "string" || Object.keys(first).length !== 2) {
    return "Send exactly one user message.";
  }
  const content = first.content;
  if (content.trim() === "") return "Write a message and mask it first.";
  if (content.length > MAX_MASKED_CHARS) return `That message is ${content.length} characters after masking; the limit is ${MAX_MASKED_CHARS}.`;
  const maxTokens = b.max_tokens === undefined ? 512 : b.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024) return "max_tokens must be a whole number from 1 to 1024.";
  // The same self-check as scripts/private-ask.ts: only text with nothing left to mask goes on, even if someone posts here directly.
  if (detect(content).length > 0) {
    return "That text still holds values that should be masked, such as an email, a phone number or a card number. Mask it first. Nothing was sent or paid.";
  }
  return { model: "chainaim/auto", messages: [{ role: "user", content }], max_tokens: maxTokens };
}

export function registerRelay(app: Hono, ctx: RelayCtx): void {
  const { paywallUrl, fetcher, now, log } = ctx;

  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => {
      log({ route: "chat", status: 413, withPayment: c.req.header("payment-signature") !== undefined });
      return fail(c, 413, "That request is too large.");
    },
  });

  app.post("/api/chat", tooLarge, async (c) => {
    const started = now();
    const signature = c.req.header("payment-signature");
    // withPayment: a payment header came with the request (not that it settled).
    const done = (status: number, extra: Record<string, unknown> = {}) => log({ route: "chat", status, withPayment: signature !== undefined, ms: now() - started, ...extra });

    if (signature !== undefined && signature.length > MAX_SIGNATURE_CHARS) {
      done(400);
      return fail(c, 400, "The payment header is too large.");
    }
    const checked = checkChat(await c.req.json().catch(() => undefined));
    if (typeof checked === "string") {
      done(400);
      return fail(c, 400, checked);
    }

    let upstream: Response;
    try {
      upstream = await fetcher(paywallUrl + CHAT, {
        method: "POST",
        headers: { "content-type": "application/json", ...(signature !== undefined ? { "payment-signature": signature } : {}) },
        body: JSON.stringify(checked),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch {
      done(502);
      // Once a payment was forwarded, the paywall may have settled it before the connection failed.
      if (signature !== undefined) {
        return fail(c, 502, "The connection to the payment service failed after your payment was sent. Check your wallet's recent transactions before trying again.");
      }
      return fail(c, 502, "Could not reach the payment service. You were not charged.");
    }

    const headers: Record<string, string> = { "content-type": upstream.headers.get("content-type") ?? "application/json" };
    for (const name of PASS_BACK) {
      const value = upstream.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    let body: ArrayBuffer;
    try {
      body = await upstream.arrayBuffer();
    } catch {
      // The paywall settles before it streams the answer, so a paid body lost here may already be paid for.
      done(502, { upstream: upstream.status, bodyLost: true });
      const receipt = headers["payment-response"];
      const message =
        signature !== undefined
          ? "The answer was lost after your payment went through. Check your wallet's recent transactions before trying again."
          : "Could not read the payment service's answer. You were not charged.";
      return c.json({ error: { message } }, 502, receipt !== undefined ? { "payment-response": receipt } : {});
    }
    done(upstream.status, { upstream: upstream.status, maskedChars: checked.messages[0].content.length });
    return new Response(body, { status: upstream.status, headers });
  });
}
