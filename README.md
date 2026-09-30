# chainaim-router

ChainAim's privacy gateway for AI agents. Agents pay per call in USDC on Algorand (x402) for three services: find personal, health and card data in text (**scan**), replace it with placeholders they can restore (**mask**), and an OpenAI-compatible **private chat** that masks the conversation before any model sees it.

```
agent ──HTTPS──▶ paywall (public, x402) ──private network──▶ gateway ──▶ OpenRouter free models (chat)
                   │                                           ├──▶ OpenRouter Decisions API (Jev)
                   └──▶ GoPlausible facilitator                └──▶ Presidio analyzer (private)
```

**Demo video:** [PrivacyBuddy by ChainAIm, about 1:45](https://drive.google.com/drive/folders/15Fsxdb3XhDuQvI8KrPXEhf7lrpXNk_Zw). A support agent masks a customer message in the browser, pays one cent per answer over x402, and gets the reply with the real details restored.

Setup on your machine: `SETUP.md`. Design: `docs/superpowers/specs/2026-09-24-privacy-gateway-design.md`. Deployment: `docs/deploy/railway.md`. Decisions: `docs/adr/`.

## Paid endpoints (the paywall)

| Method | Path | Price | What it does |
| --- | --- | --- | --- |
| POST | /v1/privacy/scan | $0.01 | Entities (type, UTF-16 start/end, score), classes (PHI, PCI, PII) and the data policy. No model is called. |
| POST | /v1/privacy/mask | $0.01 | Masked text (`<PERSON_1>`, `[CARD REMOVED]`), the map to restore it, counts |
| POST | /v1/chat/completions | $0.01 | Private chat: mask, classify with Jev, route across free models, restore the answer |
| GET | /v1/models, /healthz | free | The model list; liveness |

Each price is set on the paywall by `PRICE_SCAN`, `PRICE_MASK` and `PRICE_CHAT` (for example `$0.01`); an unset variable means $0.01. Changing a price needs no code change and does not affect the payTo address.

Every refusal (4xx, 5xx) is free: the payment settles only when the gateway answers below 400. Chat asks for payment only when free-model capacity is available; any refusal after payment is free. Health data only goes to model providers that don't collect data; if none is available, the request is refused and not charged.

## Mask on your own computer first (`private-ask`)

`services/paywall/scripts/private-ask.ts` reads a text file and masks it **on your computer** before anything is sent: names after a label (`Patient:`, `Name:` at the start of a line, `Dr.`, `Mr./Mrs.`), Aadhaar, PAN, IFSC, card numbers (Luhn check), Indian mobile numbers, email addresses, and bank account and medical record numbers next to a label. It shows exactly what will leave, then pays over x402 and sends only the masked text. Placeholders look like `<C_PERSON_1>`; card numbers become `[CARD REMOVED]` and are never restored. Placeholders in the answer are put back on your computer, and the map never leaves it.

The gateway still scans the masked text with Presidio as a second check, and counts each `<C_TYPE_n>` as the value it replaced, so a masked prescription keeps the no-collection policy for health data.

```bash
cd services/paywall
node scripts/private-ask.ts --file prescription.txt --endpoint scan --dry-run
AVM_MNEMONIC="<buyer's 25 words>" node scripts/private-ask.ts --file prescription.txt --url https://PAYWALL --endpoint chat
```

Flags: `--endpoint chat|scan|mask` (default chat), `--question`, `--max-tokens` (1 to 1024), `--dry-run` (sends and pays nothing), `--keep-masked`, `--no-names`. Limits: `.txt` and `.md` files only; the checks are patterns, not a language model, so a name without a label can be missed on the computer and is left to the gateway's scan. Diagnoses, drugs, ages, dates and places are not masked, because the model needs them or they are not detected.

## Gateway routes (private, behind the gateway key)

The paid routes above, plus `POST /v1/route/explain` (the chat decision without a model call), `GET /internal/capacity` (the paywall's chat guard), `GET /v1/deployments`, and `GET /healthz` (no key: 200 when Presidio answered its last check). Chat responses carry `x-chainaim-decision-id`, `x-chainaim-data-class`, `x-chainaim-classifier`, `x-chainaim-model` and `x-chainaim-attempts`.

## Run it locally (no keys, no Docker)

The stubs stand in for Presidio and OpenRouter and use synthetic data only (`scripts/synthetic-corpus.ts`).

```bash
npm run stub-presidio
npm run stub-openrouter
OR_DUMMY=sk-or-dummy node services/gateway/src/main.ts --model-source openrouter-free --openrouter-base-url http://127.0.0.1:5003 --openrouter-key-env OR_DUMMY
node scripts/smoke.ts --chat
```

The paywall in front of it (TestNet; replace `YOUR_TESTNET_ADDRESS` with a real Algorand address of yours, 58 characters with a valid checksum, for example one from `node scripts/new-account.ts`; nothing is paid locally):

```bash
cd services/paywall && npm install
AVM_PAY_TO=YOUR_TESTNET_ADDRESS GATEWAY_URL=http://127.0.0.1:8700 CHAINAIM_GATEWAY_KEY=local HOST=127.0.0.1 npm start
node scripts/pay.ts --dry-run http://127.0.0.1:8080/v1/privacy/scan '{"text":"Jane Roe"}'
```

## Tests

```bash
npm test               # gateway (Node test runner, real sockets, stubs)
npm run test:paywall   # paywall (stub facilitator and gateway)
npm run test:engine    # the forked route engine (needs its dev dependencies)
```

## Flags and live checks

`node services/gateway/src/main.ts --help` lists every flag. `npm run verify:presidio` checks a running Presidio (V4); `npm run verify:openrouter` checks OpenRouter with your key (V1, V2, V5).

## Privacy rules in short

Presidio runs on the private network, and message text and tool-call arguments leave only after they are masked; if Presidio is down, scan, mask and chat (and the private `/v1/route/explain`) answer 503 and `/healthz` reports 503, while the model list, capacity and deployment routes don't depend on Presidio. The decision ledger never holds text, placeholders or the map. Payment headers are stripped before the gateway, so it never learns who paid. Only allowlisted request fields reach a model, so a client can't override the data policy. Chat scans message text and tool-call arguments (keys and values); tool definitions, the `response_format` schema, stop sequences, `tool_choice`, and tool-call ids and function names are forwarded as sent without scanning, so don't put personal data in them.
