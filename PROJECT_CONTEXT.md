# PROJECT_CONTEXT: ChainAim privacy gateway

**What it is.** Paid privacy services for AI agents on Algorand (x402, USDC through the GoPlausible facilitator): scan, mask and an OpenAI-compatible private chat that masks the conversation, routes it with Jev across OpenRouter's free models under a data policy, and restores the answer.

**Status (2026-09).** Built for the Algorand Global x402 Challenge (Composite entry): scan and mask, the paywall, and private chat, with tests over stubs. Deployment follows `docs/deploy/railway.md`. Design: `docs/superpowers/specs/2026-09-24-privacy-gateway-design.md`. Plan: `docs/superpowers/plans/2026-09-25-privacy-gateway.md`.

## Components
| Name | Path | Role |
| --- | --- | --- |
| chainaim-paywall | services/paywall | Public: x402 payment, Bazaar metadata, chat capacity guard, proxy that strips payment headers, payment log |
| chainaim-gateway | services/gateway | Private: Presidio client, masking and restore, chat pipeline, free-pool routing, quota, decision ledger |
| Presidio analyzer | services/presidio | Private: entity detection (derived image enabling the Indian recognizers) |
| @chainaim/route-engine | packages/route-engine | The rules classifier used when Jev is off or the request is PHI (fork of BlockRunAI/router-core, MIT) |
| scoring table | config/free-models.json | Quality, tasks, speed and domains per free model |
| decision ledger | data/ledger/ (gitignored; /data/ledger on Railway) | One line per request; never text, placeholders or the map |

## Constraints
- The gateway has no npm runtime dependencies (Node built-ins; Node runs the TypeScript). The paywall uses Hono and the official x402 libraries.
- Secrets never go in config or git: environment variable NAMES only (`.env.example`).
- Presidio unreachable means 503 everywhere: text that has not been scanned is never sent anywhere.
- Health data (PHI) goes only to providers that don't collect data (`provider.data_collection: deny`), and never to Jev.

## Run and test
See README.md. `npm test`, `npm run test:paywall`, `npm run test:engine`.

## Sources of truth
- x402 on Algorand: `@x402/*` 2.27.0, `@x402-avm/extensions` 2.6.1, GoPlausible facilitator guide
- OpenRouter: models, key, chat and Decisions API references
- Presidio: `presidio-analyzer` 2.2.362
- Decisions: docs/adr/
