# chainaim-router

ChainAim's privacy gateway for AI agents. Agents pay per call in USDC on Algorand (x402) for three services: find personal, health and card data in text (**scan**), replace it with placeholders they can restore (**mask**), and an OpenAI-compatible **private chat** that masks the conversation before any model sees it.

```
agent ──HTTPS──▶ paywall (public, x402) ──private network──▶ gateway ──▶ OpenRouter free models (chat)
                   │                                           ├──▶ OpenRouter Decisions API (Jev)
                   └──▶ GoPlausible facilitator                └──▶ Presidio analyzer (private)
```

Setup on your machine: `SETUP.md`. Design: `docs/superpowers/specs/2026-09-24-privacy-gateway-design.md`. Deployment: `docs/deploy/railway.md`. Decisions: `docs/adr/`.

## Paid endpoints (the paywall)

| Method | Path | Price | What it does |
| --- | --- | --- | --- |
| POST | /v1/privacy/scan | $0.002 | Entities (type, UTF-16 start/end, score), classes (PHI, PCI, PII) and the data policy. No model is called. |
| POST | /v1/privacy/mask | $0.003 | Masked text (`<PERSON_1>`, `[CARD REMOVED]`), the map to restore it, counts |
| POST | /v1/chat/completions | $0.01 | Private chat: mask, classify with Jev, route across free models, restore the answer |
| GET | /v1/models, /healthz | free | The model list; liveness |

Every refusal (4xx, 5xx) is free: the payment settles only when the gateway answers below 400. Chat asks for payment only when free-model capacity is available; any refusal after payment is free. Health data only goes to model providers that don't collect data; if none is available, the request is refused and not charged.

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

The paywall in front of it (TestNet, a made-up payTo; nothing is paid locally):

```bash
cd services/paywall && npm install
AVM_PAY_TO=IDNTKBLAMSMIBR5DV5GRRZC7PNDOGRUOSOLHZ7BIOVXJPOWT2O24BMVDPE GATEWAY_URL=http://127.0.0.1:8700 CHAINAIM_GATEWAY_KEY=local HOST=127.0.0.1 npm start
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
