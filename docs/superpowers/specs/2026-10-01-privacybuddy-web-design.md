# PrivacyBuddy web: design

Date: 2026-10-01 · Status: approved in chat, written for review

## Goal

A public-facing page where a person types a private message, sees it masked on
their own device, and then pays (USDC on Algorand, x402) to have a model answer
the masked text. The answer comes back with the original values put back on the
page. The page shows the buyer wallet and the pay-to wallet, top right, under
the slogan "Spend your tokens wisely".

## Decisions already made with the owner

- Payment: a **demo buyer wallet held by the server** signs each payment
  automatically. No wallet connect in this version.
- Architecture: a **new small service, `services/web`**, separate from the
  paywall, so the buyer key never lives in the public money path.
- Masking: **in the browser**, with the existing `services/paywall/scripts/client-mask.ts`
  (no dependencies). Nothing is sent or paid until the user clicks Execute.
- Name and slogan in the UI: "PrivacyBuddy", "Spend your tokens wisely".

## Non-goals

Wallet connect, accounts, chat history, streaming, PDF or image upload,
MainNet use of the demo wallet, a Railway deployment (a Dockerfile can follow).

## Flow

1. The user types a message and clicks **Mask**. The page runs `maskText` on the
   device and shows the masked text with placeholders highlighted, the counts,
   and a note that card numbers are removed for good. The user can edit and
   mask again. Nothing has left the device.
2. The user clicks **Execute · $price**. The page sends only the masked text to
   `POST /api/execute`. The restore map stays in the page.
3. The server pays the paywall's chat route from the buyer wallet and returns
   the answer, the model, the data class and the payment transaction id.
4. The page puts the original values back into the answer (`restore`), renders
   it, and links the payment to lora.

## Components

```
services/web/
  package.json            own dependencies (hono, @hono/node-server, @x402/fetch, @x402/avm, algokit-utils)
  src/main.ts             reads config, starts the server
  src/config.ts           environment variables, validated
  src/app.ts              createWebApp(deps): the routes; everything outside is injected
  src/buyer.ts            builds the x402 payer from BUYER_MNEMONIC (same set-up as scripts/pay.ts)
  src/wallets.ts          reads payTo, network, asset and price from the paywall's 402; reads the buyer's balance
  src/limits.ts           per-visitor rate limit and an hourly spend cap
  public/index.html       the page, with its CSS and script
  test/*.test.ts          node:test, with a stand-in paywall and a fake payer
```

`client-mask.ts` is reused, not copied. The service serves it to the browser at
`/client-mask.js` by converting it with Node's `stripTypeScriptTypes` at start-up
(same source, no build step). The server imports the same file for its own check.

## API

- `GET /` and static files: the page.
- `GET /client-mask.js`: the masking module as browser JavaScript.
- `GET /healthz`: `{"status":"ok"}`.
- `GET /api/wallets`: `{ network, asset, buyer: { address, usdc, algo } | null, payTo: { address }, prices: { chat } }`.
  `payTo`, `network`, `asset` and the price come from the paywall's own 402 quote
  for the chat route, so the page always shows what the paywall really asks.
  The buyer address is derived from the key; the balance comes from a public
  Algorand node. If the key is not set, `buyer` is null.
- `POST /api/execute` with `{ "masked": string, "maxTokens"?: 1..1024 }`:
  200 `{ answer, model, dataClass, payment: { transaction, network } }`.
  Errors (always `{ "error": { "message": "..." } }`, in plain words):
  - 400 empty, too long (over 48,000 characters) or the text still holds a value
    that `detect` would mask. The server runs the same self-check as
    `private-ask.ts`, so a direct POST cannot slip raw values through.
  - 429 rate limit or hourly spend cap reached.
  - 503 `BUYER_MNEMONIC` is not set.
  - 402 the buyer wallet has too little USDC (checked before paying).
  - 502 the paywall, the gateway or the payment failed. The message says whether
    the user was charged, using the paywall's own "you were not charged" wording.

## Configuration (environment variables)

| Variable | Meaning |
|---|---|
| `PAYWALL_URL` | required; the paywall, e.g. `http://127.0.0.1:8080` or the Railway address |
| `BUYER_MNEMONIC` | the demo buyer's 25 words; only in the environment, never in the repo, never logged |
| `PORT`, `HOST` | default `8740` and `127.0.0.1` |
| `RATE_PER_MINUTE` | executes per visitor per minute, default 5 |
| `MAX_EXECUTES_PER_HOUR` | spend cap across all visitors, default 30 |

## Privacy and safety

- The server receives only masked text. It never sees the restore map and never
  logs text, placeholders or the map; it logs status codes, sizes and timing.
- The key is read once at start-up, used only to sign, and never returned or
  logged. `/api/wallets` returns only the public address.
- The demo wallet is TestNet money. The rate limit and hourly cap bound what a
  stranger can spend through the page. The in-memory limits reset on restart.
- Model output is untrusted: the page renders it with the same safe
  renderer used in the test console (text nodes only, no raw HTML).

## UI

One responsive page, bright and dark themes, no external fonts or scripts.

- Top bar: brand on the left; on the right two chips, **Buyer** and **Pay to**,
  each with a short address (`EA7WAS…464M`), a copy button and a lora link, plus
  and the buyer's USDC balance. The page shows no network badge.
- Headline: "Spend your tokens wisely", with one line under it: private AI chat,
  masked on your device, paid per answer in USDC on Algorand.
- Card with a three-step indicator, **1 Write, 2 Masked, 3 Execute**, the text
  box, the masked view (placeholders highlighted, what left nothing), the answer
  (originals restored), model and data-class pills, and the payment link.
- Friendly states: "Buyer wallet has no USDC", "Model busy, nothing charged",
  "Payment service unreachable", and a clear empty state.

## Testing

- Unit tests (`node --test`) for the routes with a fake payer and a stand-in
  paywall: validation, the unmasked-value refusal, limits, each error status,
  the wallet read, and that no response or log line contains the submitted text.
- `client-mask.ts` already has its own tests; the served `/client-mask.js` is
  checked to export the same functions and to mask and restore a sample.
- Browser check in the Browser pane: layout, the three steps, the error states.
- **Not testable now:** a real payment, because the BUYER holds no TestNet USDC.
  The payer is the same code as `private-ask.ts`; it is exercised for real once
  USDC arrives.

## Risks

- `stripTypeScriptTypes` is marked experimental in Node 24. If it changes, the
  fallback is a one-line copy of the file to `public/` at build time.
- A server-side hot wallet is acceptable for a TestNet demo only. Before any
  MainNet use, replace it with wallet connect.
