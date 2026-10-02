# PrivacyBuddy: pay with the Lute wallet

Date: 2026-10-02 · Status: approved in chat, written for review

## Goal

The person using PrivacyBuddy pays for each answer from their own Lute wallet
in the browser. Nobody types 25 words, and the PrivacyBuddy server holds no
wallet key at all. Everything else on the page works as it does in the demo
video.

## Decisions already made with the owner

- **Lute only.** The server-side demo wallet (`BUYER_MNEMONIC`) is removed, not
  kept as a fallback. Visitors without Lute can mask but cannot Execute.
- **The paid request goes through the PrivacyBuddy server** (a pass-through),
  not straight from the browser to the paywall. The paywall is not changed.
- **Edit on `main`.** The version in the demo video is kept under the tag
  `demo-video-v1` (commit `96ecb01`).
- **The page looks the same** apart from the Buyer chip, top right.

## Non-goals

Other wallets (Pera, Defly, WalletConnect), MainNet launch, changes to the
paywall, gateway or Presidio, a Railway deployment of the web service, chat
history, streaming.

## Flow

```
browser ── Lute signs ──┐
   │                    ▼
   │  x402 fetch ──▶ POST /api/chat (PrivacyBuddy server) ──▶ paywall /v1/chat/completions
   │                     pass-through: 402 and payment headers in, answer and receipt out
   └──▶ algonode (public): transaction parameters and the buyer's balance
```

1. **Connect.** The visitor clicks **Connect Lute**. The page reads the
   network from `/api/wallets` (taken from the paywall's 402 quote, TestNet
   today) and calls `lute-connect`'s `connect(genesisID)`. Lute returns one or
   more addresses; the page uses the first. The address (only the address) is
   kept in `localStorage` so a reload doesn't ask again.
2. **Mask.** Unchanged: `maskText` in the browser, nothing leaves the device.
3. **Execute.** The page builds an `@x402/fetch` client with
   `ExactAvmScheme` and a signer `{ address, signTransactions }`.
   `signTransactions(txns, indexesToSign)` sends the group to Lute's
   `signTxns`, marking the transactions not in `indexesToSign` as not to be
   signed (`signers: []`), and returns Lute's results in the same order with
   `null` for the unsigned ones. `algodUrl` is the algonode host for the
   quote's network. The page calls `POST /api/chat` with the masked message.
4. **Relay.** `/api/chat` checks the body, then forwards it to the paywall's
   `/v1/chat/completions` with the `payment-signature` header if present. The
   first call comes back 402; the x402 client asks Lute to sign (the visitor
   approves in the Lute window) and retries with the signed payment.
5. **Answer.** On 200 the page reads the answer, the model and data class
   headers, and the receipt from the `payment-response` header (decoded with
   `x402HTTPClient.getPaymentSettleResponse`), then restores the placeholders
   and shows the receipt link exactly as today.

If Execute is pressed before connecting, the page runs the connect step first
and stops there with "Connected. Press Execute again to pay.": without the
Lute extension the signing pop-up needs a click of its own, or the browser
blocks it.

## Server: `services/web`

### `/api/chat` (replaces `/api/execute`)

Input checks, the same as `/api/execute` today, each answered 400 with nothing
forwarded:

- `model` must be `chainaim/auto`, one `user` message whose content is a
  non-empty string of at most 48,000 characters, `max_tokens` a whole number
  from 1 to 1024. Any other field is refused.
- `detect()` from `src/mask.ts` must find nothing left to mask.

Then a pass-through to the paywall:

- Sent on: the validated JSON body (rebuilt, not the raw bytes) and
  `payment-signature` if present. No other request header.
- Sent back unchanged: the status, the body, and the `payment-required`,
  `payment-response`, `x-chainaim-model` and `x-chainaim-data-class` headers.
- The paywall can't be reached and no payment header was sent: 502 "Could not
  reach the payment service. You were not charged."
- The connection fails after a payment header was sent: 502 "The connection to
  the payment service failed after your payment was sent. Check your wallet's
  recent transactions before trying again." The paywall settles before it
  streams the answer, so once a payment was sent the relay never says "not
  charged".
- The answer's body is lost after the paywall answered: 502, keeping any
  `payment-response` header; with a payment header "The answer was lost after
  your payment went through. Check your wallet's recent transactions before
  trying again.", without one "Could not read the payment service's answer.
  You were not charged."
- Timeout: 240 seconds (the paywall's 200 s gateway timeout plus margin for
  its capacity check, payment verify and settle).
- Body size: at most 256 KB, else 413 "That request is too large."
- Log line: route, status, upstream status, whether a payment header was
  present, masked length, time. Never the text, the signature or the receipt.

### `/api/wallets`

Keeps `network`, `asset`, `payTo` and `prices.chat` from the paywall's quote,
and adds `genesisId` and `algodUrl` for that network. Drops `buyer`: the
balance of the connected address is read by the browser from algonode.

### Removed

`src/buyer.ts`, `src/limits.ts`, their tests, `BUYER_MNEMONIC`,
`RATE_PER_MINUTE`, `MAX_EXECUTES_PER_HOUR` and the server-side balance read.
The limits only protected the shared demo wallet; each visitor now spends
their own TestNet USDC. `readBalance` leaves `src/wallets.ts` (and its tests);
the browser's `balance()` in `src/wallet-entry.ts` does the same read.

### Content security policy

`connect-src` becomes `'self' https://testnet-api.algonode.cloud
https://mainnet-api.algonode.cloud`. `script-src` stays `'self'
'unsafe-inline'`. If `lute-connect` opens an iframe or popup on `lute.app`,
`frame-src https://lute.app` is added; the implementation checks this against
the library.

## Browser code

- `src/wallet-entry.ts`: imports `lute-connect`, `@x402/fetch`, `@x402/avm`
  and `@x402/core`, and exports `connect()`, `disconnect()`, `balance()` and
  `payAndAsk(masked)` for the page. The Lute signer adapter is its own small
  exported function so it can be tested without a browser.
- `public/wallet.js`: built from it by `esbuild` (a dev dependency) with
  `npm run build:wallet`, and committed, the same way
  `packages/route-engine/dist` is committed. The server serves it like
  `/client-mask.js`. A test fails if the committed bundle is older than its
  source (it compares a hash written into the bundle's banner).
- `public/index.html`: the Buyer chip and `doExecute` change; everything else
  stays.

## The page

The Buyer chip:

- **Not connected:** a **Connect Lute** button in place of the address.
- **Connected:** as in the video (short address, USDC balance, Copy, ↗) plus
  a small **Disconnect**, which clears `localStorage`.

Execute keeps its label and price. While Lute is open the status line says
"Approve the payment in Lute…".

## Errors

All shown in the existing red box. Rule: once Lute has signed, no message says
"nothing was paid" or "not charged", because the payment may have settled.

| Case | Message |
|---|---|
| Lute not installed or its window blocked | Lute could not open. Install it or allow pop-ups, with a "Get Lute" link to https://lute.app |
| Visitor closes or rejects the Lute window | You cancelled the payment. Nothing was paid. |
| Wallet's network differs from the paywall's | Names both networks |
| Balance known to be below the price | The current "fund it with TestNet USDC" message and the faucet link; nothing is sent |
| Wallet not opted in to USDC | The wallet needs to opt in to USDC (asset 10458941) first |
| Lute does not answer in time | Lute did not answer in time. Nothing was paid. (Without the extension it adds: if no Lute window appeared, allow pop-ups for this page.) |
| Paywall refuses the payment (402) | The payment was not accepted (wallet USDC and opt-in); the visitor is not charged |
| Connection or server error (5xx) after signing | The connection failed after you approved the payment. Check your wallet's recent transactions before trying again. (A relay message that already speaks of the payment is shown as is.) With a receipt link when the payment settled |

## Testing

- **Server** (`test/app.test.ts`, stand-in paywall): `/api/chat` passes the
  402 and its headers through; forwards `payment-signature` and nothing else;
  passes a paid 200 with `payment-response` through; refuses unmasked text,
  oversize text, bad `max_tokens` and extra fields without calling the
  paywall; answers 502 when the paywall is down; logs no text.
  `/api/wallets` returns `genesisId` and `algodUrl` and no `buyer`.
- **Signer adapter** (`test/lute-signer.test.ts`, a fake `signTxns`): base64
  round-trip of the transactions; only `indexesToSign` are signed, the rest
  come back `null`; a Lute rejection becomes the "cancelled" error.
- **Bundle freshness:** the test above on `public/wallet.js`.
- **By hand, TestNet:** connect Lute in Chrome, pay one answer, open the
  receipt on lora, and check the paywall logs one `payment_settled` line.
  The owner does this step; Lute's window can't be driven by the agent.

## Docs

`services/web/README.md` (install Lute, no 25 words, the build step) and
level 5 of `ONBOARDING.md`.

## Risks

- `lute-connect` 2.0.1's exact `signTxns` input and output shape and how it
  opens (extension or popup) are confirmed against the package before the
  adapter is written.
- The x402 AVM client and algokit-utils must bundle for the browser. If
  `esbuild` can't bundle them cleanly, stop and revisit before changing the
  page.
