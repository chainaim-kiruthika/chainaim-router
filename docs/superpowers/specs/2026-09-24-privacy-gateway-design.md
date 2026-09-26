# ChainAim Privacy Gateway: design

- Date: 2026-09-24
- Status: design approved in brainstorming; this spec is awaiting review
- Owner: Sathya Krishnasamy
- Context: Algorand Global x402 Challenge, Composite entry. Project information is due 2026-09-29, 11:45 pm EST. The leaderboard measures usage during an unannounced window in October.
- Builds on: [docs/PLAN.md](../../PLAN.md) (Iteration 1 privacy design) and [ADR 0001](../../adr/0001-own-gateway-fork-route-engine-only.md)

## 1. Goal

A paid, privacy-first model gateway for AI agents on Algorand. Agents pay per call in USDC via x402 and get three services:

1. **scan**: find personal, health and card data in a text.
2. **mask**: replace that data with numbered placeholders the caller can restore later.
3. **chat**: an OpenAI-compatible chat call. The conversation is masked before any model sees it, TypeSafe's Jev classifies it, a scoring table picks one of OpenRouter's free models, and the original values are put back into the answer.

Success means that by 2026-09-29:

- all three endpoints are live on Algorand MainNet through the GoPlausible facilitator, listed in the Bazaar under `x402-global-challenge`, each with at least one real payment;
- the launch-gate tests in section 11 passed before `chat` went live;
- the submission text matches what is live.

Out of scope: a vault with a TTL (the placeholder map lives for one request only), human escalation, token-by-token streaming restore, scanning images (requests with images are refused), self-hosted or Baseten models in production, the `x402-merchant` extension, and the `chainaim/eco` and `chainaim/premium` profiles.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Jev (`typesafe/jev-1.13`) classifies each chat request through OpenRouter's Decisions API, and a scoring table picks the model. | Jev answers in 70 to 500 ms at $0.042 per million input tokens. A table keeps choices explainable and works unchanged when Jev is unavailable. |
| D2 | Every answer comes from an OpenRouter free model (id ends in `:free`). No self-hosted or other hosted models in production. | Owner's choice: API keys only, no inference on hardware ChainAim runs. |
| D3 | Free models serve the paid `chat` endpoint without first asking OpenRouter. | Owner accepts the risk under section 7 of OpenRouter's terms (reselling API access to models). Mitigation: scan and mask never use OpenRouter, and chat refuses without charging if the key stops working. |
| D4 | Health data is masked and sent only with `provider.data_collection: "deny"`. If no provider qualifies, the request is refused and not charged. | The strongest privacy setting available when only free models are used. |
| D5 | Presidio analyzer (Docker) detects entities on the same private network as the gateway. | Best detection, names included. Raw text never leaves ChainAim's containers. |
| D6 | Hosting is a managed container platform (Railway recommended, Fly.io equivalent), always on, no GPU. | The endpoint must be reachable 24/7 through October. The owner's PC is not involved. |
| D7 | x402 lives in a separate `paywall` service (Hono with `@x402/hono`). The gateway keeps zero npm runtime dependencies. | Reuses the official middleware unchanged and keeps ADR 0001's gateway constraint. |
| D8 | `/v1/chat/completions` always runs the privacy pipeline. The `chainaim/*` routing profiles are retired from the chat path. | Every model is free, so cost profiles no longer mean anything. One code path. |
| D9 | Jev never sees a request already classed as health data. The rule engine classifies those. | Health text only goes to no-collection providers, and TypeSafe has not published a retention policy. |

## 3. Architecture

```
agent ──HTTPS──▶ paywall (public) ──private network──▶ gateway ──▶ OpenRouter chat (free models)
                   │                                     ├──▶ OpenRouter Decisions API (Jev)
                   └──▶ GoPlausible facilitator          └──▶ Presidio analyzer (private)
```

| Service | Code | Role | Public |
|---|---|---|---|
| paywall | `services/paywall` (new) | x402 payment, Bazaar metadata, capacity guard, proxy to the gateway, payment log | yes, HTTPS |
| gateway | `services/gateway` (existing) | privacy pipeline, routing, OpenRouter calls, decision ledger | no |
| presidio | `mcr.microsoft.com/presidio-analyzer`, pinned tag | entity detection | no |

The paywall removes payment headers before proxying, so the gateway never learns who paid. The gateway keeps its existing rule that it only listens on a non-loopback address when `--api-key-env` is set; the paywall holds that key.

### New and changed gateway files

| File | Purpose |
|---|---|
| `src/privacy/presidio.ts` | Presidio client: `POST /analyze` with ad-hoc recognizers, and a `GET /supportedentities` check at startup |
| `src/privacy/entities.ts` | Entity groups (masked, card, medical ID), the health-term list, MRN and NPI patterns |
| `src/privacy/classify.ts` | Entities to classes found, `dataClass` and policy |
| `src/privacy/mask.ts` | Mask a text or a conversation, remove card numbers, build the placeholder map |
| `src/privacy/restore.ts` | Restore strings, messages and tool-call arguments (JSON-safe) |
| `src/routing/freepool.ts` | Sync OpenRouter's free chat models |
| `src/routing/scores.ts` | Load `config/free-models.json`, defaults for unknown models, the score function |
| `src/routing/select.ts` | Eligibility filters and ranking into a chain |
| `src/routing/jev.ts` | Decisions API client |
| `src/routing/classify.ts` | Jev first, rules fallback: task, difficulty, health flag, which classifier ran |
| `src/routing/quota.ts` | Per-minute window, daily remaining, `capacity()` |
| `src/openrouter.ts` | Request shaping and failure categories for OpenRouter |
| `src/chat.ts` | The private chat pipeline |
| `src/server.ts` | New routes (section 8) |
| `src/pool.ts` | Cooldown fix, deployments added and removed at runtime, probes off for OpenRouter |
| `src/dispatch.ts` | Per-request extra body fields (`provider`) and failure categories |
| `src/main.ts` | New flags (section 10) |

## 4. Request flows

### scan: `POST /v1/privacy/scan`

1. Validate `{ "text": string }`, 1 to 20,000 characters.
2. Detect with Presidio plus the ad-hoc recognizers.
3. Classify. Return entities (type, start, end, score), counts, `found`, `dataClass` and `policy`.

No Jev call and no model call.

### mask: `POST /v1/privacy/mask`

Steps 1 to 3 of scan, then mask. Return `maskedText`, `map`, counts, `found`, `dataClass` and `cardsRemoved`.

### chat: `POST /v1/chat/completions`

1. **Validate.** `messages` is required. Requests with image parts get 400. Total message text is at most 48,000 characters. `max_tokens` (or `max_completion_tokens`) is capped at 1,024, and defaults to 1,024.
2. **Detect** over every text field: string `content` and text parts of every role, and assistant `tool_calls[].function.arguments`. Tool definitions (`tools`) are written by the developer and are not scanned.
3. **Classify locally** to get `dataClass`.
4. **Mask** the whole conversation with one shared numbering.
5. **Classify the task.** Jev reads the masked text unless `dataClass` is PHI; the rule engine runs instead for PHI or when Jev fails. If Jev says the request is about a specific person's health (probability at least 0.5), `dataClass` becomes PHI.
6. **Select** a chain of up to three free models for the task, difficulty and data policy.
7. **Call** OpenRouter model by model (section 7) with the masked body and the data policy.
8. **Restore** placeholders in the answer.
9. **Respond** in the OpenAI shape. For `stream: true`, send one SSE chunk with the whole restored answer, then `[DONE]`. Write the ledger line.

## 5. Privacy rules

### Entities

| Group | Entities | Treatment |
|---|---|---|
| Personal | PERSON, EMAIL_ADDRESS, PHONE_NUMBER, IN_AADHAAR, IN_PAN, US_SSN, IP_ADDRESS, IBAN_CODE, US_PASSPORT, US_DRIVER_LICENSE, CRYPTO | replaced with `<TYPE_N>` |
| Card | CREDIT_CARD (Presidio validates the Luhn checksum) | replaced with `[CARD REMOVED]`, never restored |
| Medical ID | MEDICAL_LICENSE (Presidio), MEDICAL_RECORD and US_NPI (ad-hoc patterns that need a context word: `MRN`, `medical record`, `NPI`) | replaced with `<TYPE_N>` |
| Health term | ChainAim list of conditions, drugs and procedures, sent as an ad-hoc deny-list recognizer named `HEALTH_TERM` | not replaced (the model needs it); used only to classify |

LOCATION, DATE_TIME, NRP and URL are deliberately not masked, because masking them breaks ordinary answers. The Presidio score threshold is 0.4 (flag). When results overlap, the longer span wins; on equal length, the higher score wins.

### Classes

- `found` lists every class present: `PCI` if any card was found, `PHI` if the PHI rule holds, `PII` if any personal entity was found.
- PHI rule: a medical ID is present, or a health term and a personal entity both appear in the same text (scan, mask) or conversation (chat). In chat, Jev's health flag also sets PHI.
- `dataClass` is the first of `PHI`, `PCI`, `PII`, `none` that appears in `found`.
- `policy.dataCollection` is `deny` for PHI and `allow` otherwise. `policy.cardDataRemoved` is true when any card was found.
- Scan and mask report the policy from local detection only. Chat can tighten it further with Jev's health flag.

### Placeholders

- The format is `<TYPE_N>`. N counts per type from 1 in order of first appearance: messages in order, left to right within each message.
- The same original value (exact match after trimming; emails compared in lowercase) gets the same placeholder everywhere in the request.
- The map exists only in memory for the length of the request.

### Restore

- Replace `<TYPE_N>` (case-insensitive, spaces allowed inside the brackets) in `message.content`, any `reasoning` or `refusal` string, and `tool_calls[].function.arguments`.
- Inside tool-call arguments the original value is JSON-escaped before it is inserted, so the arguments stay valid JSON.
- A placeholder with no map entry stays as it is and is counted in the ledger as `unresolvedPlaceholders`.

### What leaves the server

| Recipient | Receives |
|---|---|
| Jev (OpenRouter Decisions API) | Masked text of chat requests that are not PHI: the masked system prompt (first 1,000 characters) and the last three messages of any role (up to 7,000 characters) |
| OpenRouter chat | The masked conversation, `max_tokens`, tools and the data policy |
| GoPlausible and Algorand | The payment only |

Before calling OpenRouter, the gateway removes any client-supplied `provider`, `models`, `route`, `transforms`, `plugins`, `user` and `metadata` fields. A client therefore cannot override the data policy or pass an identifier through `user`.

### Logs

- **Decision ledger** (the existing file ledger, on a mounted volume): fields in section 8.4. It never holds text, placeholders, the map or tool arguments. Upstream error bodies are not stored, only a failure category.
- **Payment log** (paywall, stdout): time, route, amount, payer and transaction id. No decision id and no bodies.
- The paywall never logs request or response bodies.

### Fail closed

If Presidio is unreachable or returns an error, scan, mask and chat all return 503. Text that has not been scanned is never sent anywhere.

## 6. Routing

### Free pool

- Every 6 hours (flag) the gateway fetches `GET https://openrouter.ai/api/v1/models`, which needs no key.
- A model is kept if its id ends in `:free`, its output modalities include text, and it matches no exclusion pattern: `*content-safety*`, `stealth/*`, `openrouter/*`.
- For each model the gateway records the id, `context_length`, `top_provider.max_completion_tokens`, tool support (`tools` in `supported_parameters`) and JSON output (`response_format` or `structured_outputs`). Image support is not recorded, because chat refuses images.
- If a sync fails, the last good list stays in use. Until the first successful sync, chat reports no capacity.
- On 2026-09-24 the pool has 19 models.

### Classification with Jev

`POST https://openrouter.ai/api/alpha/decisions` with `Authorization: Bearer $OPENROUTER_API_KEY` and an 800 ms timeout (flag):

```json
{
  "model": "typesafe/jev-1.13",
  "state": { "request": "<masked text>", "has_tools": false, "prompt_tokens": 412 },
  "questions": {
    "task": {
      "type": "choice",
      "instructions": "What kind of task is the last user message?",
      "criteria": {
        "chat": "conversation or a simple question",
        "extraction": "pull fields or facts out of text",
        "rewrite": "rewrite, translate or summarize given text",
        "code": "write, fix or explain code",
        "reasoning": "multi-step reasoning, math or planning",
        "tool_use": "needs one of the provided tools to act",
        "long_document": "work over a long pasted document"
      }
    },
    "difficulty": {
      "type": "score",
      "instructions": "How hard is this request for a language model?",
      "criteria": ["trivial", "easy", "moderate", "hard", "expert"]
    },
    "health": {
      "type": "noul",
      "instructions": "Is this about the health, condition, treatment or medication of a specific person? The person may appear only as a placeholder such as <PERSON_1>.",
      "criteria": {
        "true": "about a specific person's health",
        "false": "not about a specific person's health; general medical questions count as false"
      }
    }
  }
}
```

The field names follow OpenRouter's Decisions API reference; verification item V1 confirms them against a live call. The result is read as: task = the most probable label; difficulty = the index of the most probable criterion plus one; health = true when its probability is at least 0.5 (flag). A timeout, a non-2xx status or an unexpected response shape sends the request to the rules fallback.

### Rules fallback (no network)

- Tier from `classifyByRules` (exported by the route engine) with `DEFAULT_ROUTING_CONFIG.scoring`. SIMPLE maps to difficulty 1, MEDIUM to 3, COMPLEX to 4, REASONING to 5, and an ambiguous result to 3.
- Task: `tool_use` when tools are attached and `inferToolRequirement` returns true; otherwise `long_document` above 8,000 estimated tokens; otherwise `code` when the `codePresence` dimension scored above 0; otherwise `reasoning` when the tier is REASONING; otherwise `chat`.
- There is no health flag in this path. PHI still comes from local detection.

### Scoring table: `config/free-models.json`

```json
{
  "version": "2026-09-24",
  "weights": {
    "qualityByDifficulty": [0.5, 0.75, 1.0, 1.25, 1.5],
    "taskMatch": 2,
    "domainMatch": 2,
    "speedWhenEasy": { "fast": 2, "medium": 1, "slow": 0 }
  },
  "defaults": {
    "qualityBySize": [[300, 8], [100, 7], [25, 6], [8, 5], [0, 3]],
    "unknownSizeQuality": 5,
    "speedBySize": [[100, "slow"], [25, "medium"], [0, "fast"]],
    "unknownSizeSpeed": "medium"
  },
  "models": {
    "qwen/qwen3.8-27b:free": { "quality": 7, "tasks": ["chat", "code", "reasoning", "tool_use", "extraction"], "speed": "medium", "domains": [] }
  }
}
```

For difficulty d (1 to 5):

score = quality × qualityByDifficulty[d − 1]
      + (task is in the model's tasks ? taskMatch : 0)
      + (request is PHI and "health" is in the model's domains ? domainMatch : 0)
      + (d ≤ 2 ? speedWhenEasy[speed] : 0)

Ties go to the faster speed class, then to the alphabetically first id. A model missing from the table gets its quality and speed from the largest `<number>b` in its id (for example `550b`), using the first row whose threshold it meets; with no size in the id it gets the unknown-size defaults and no tasks or domains.

Initial seed. These are estimates, to be tuned from ledger data in October:

| Model | Quality | Tasks | Speed | Domains |
|---|---|---|---|---|
| nvidia/nemotron-3-ultra-550b-a55b:free | 9 | reasoning, code, long_document | slow | |
| nvidia/nemotron-3-super-120b-a12b:free | 8 | reasoning, tool_use, code | medium | |
| z-ai/glm-5.2:free | 8 | reasoning, code, chat | medium | |
| thinkingmachines/inkling:free | 8 | reasoning, chat, long_document | medium | |
| qwen/qwen3.8-27b:free | 7 | chat, code, reasoning, tool_use, extraction | medium | |
| google/gemma-4-31b-it:free | 7 | chat, rewrite, extraction | medium | |
| nex-agi/nex-n2.5-pro:free | 7 | tool_use, reasoning, code | medium | |
| poolside/laguna-s-2.1:free | 7 | code, tool_use | medium | |
| google/gemma-4-26b-a4b-it:free | 6 | chat, rewrite, extraction | fast | |
| dots-studio/dots-3-note-preview:free | 6 | long_document, chat | medium | |
| nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | 6 | reasoning | fast | |
| nvidia/nemotron-3.5-lightning:free | 6 | chat, extraction, long_document | fast | |
| thinkingmachines/inkling-small:free | 6 | chat, rewrite, long_document | fast | |
| inclusionai/ling-3.0-flash-sante:free | 5 | chat, extraction | fast | health |
| inclusionai/ling-3.0-flash-fin:free | 5 | extraction, chat | fast | |
| cohere/north-mini-code:free | 5 | code | fast | |
| nex-agi/nex-n2.5-mini:free | 5 | tool_use, chat | fast | |
| poolside/laguna-xs-2.1:free | 5 | code | fast | |
| liquid/lfm-2.5-2.6b:free | 3 | chat, extraction, rewrite | fast | |

### Eligibility filters

A model enters the ranking only if all of these hold:

- tools attached: the model supports tools;
- `response_format` set: the model supports JSON output;
- estimated prompt tokens (characters divided by 4, the route engine's convention) plus `max_tokens` fit the context length, and `max_tokens` fits the model's maximum output;
- PHI request: the model is not in the deny-unavailable cache (section 7);
- the model is not cooling down.

The chain is the top three by score. An empty chain returns 503.

If the client's `model` names a model in the free pool, that model is tried alone when it passes the filters; otherwise the gateway returns 400 naming the filter that failed. Any other `model` value, including `chainaim/auto`, is ignored.

## 7. OpenRouter calls, limits and failures

Each attempt is `POST https://openrouter.ai/api/v1/chat/completions` with the masked body, `model` set to the chosen id, `max_tokens` capped, `stream: false` and `provider: { "data_collection": "allow" | "deny" }`. Client-supplied routing fields are removed first (section 5). The attempt timeout is the existing `--attempt-timeout-ms`. Upstream calls are never streamed; streaming to the client is emulated.

### Quota

- **Per minute:** at most 20 free-model calls in any 60-second window (flag). Every attempt counts.
- **Per day:** remaining calls are read from `GET https://openrouter.ai/api/v1/key` (`free_model_daily_requests`, see V2) at startup, every 10 minutes and after any 429, and counted down locally between reads.
- **`capacity()`** reports chat as unavailable when the pool is empty, the daily remaining is 0, OpenRouter rejected the key, or the minute window is full. In the last case it includes `retryAfterSec`.

### Failure categories

These are the values of `attempts[].outcome` in the ledger:

| Outcome | Detected by | Action |
|---|---|---|
| `ok` | 2xx | stop |
| `rate_limited_account` | 429 whose error names the free-model limit, per minute or per day (V5) | stop the chain; for the per-minute limit, pause free-model calls for 60 s; for the per-day limit, pause until a daily read shows capacity again |
| `rate_limited_provider` | any other 429 | cool the model down; try the next model |
| `data_policy_unavailable` | 404 whose error mentions the data policy, on a `deny` request (V5) | put the model in the deny-unavailable cache for 6 hours; try the next model |
| `key_rejected` | 401 or 403 | stop; chat is unavailable until the next key read succeeds |
| `upstream_error` | any other 4xx or 5xx | cool the model down; try the next model |
| `timeout`, `network_error`, `client_abort` | existing | existing behaviour |

When every attempt fails, the gateway returns 503, or the upstream status when it was a 4xx caused by the request itself. Either way the status is 400 or above, so the payment is not settled.

### Cooldown fix

`DEMO.md` lists a known issue: a failed deployment only comes back after a health probe passes, so `--cooldown-ms` has no effect. After the fix, a deployment is usable again once `downUntil` has passed. The next request is the trial, and a failure sends it back into cooldown. OpenRouter deployments set a new `probe: false` field, so no health requests are sent for them; the cooldown is their only health signal.

## 8. Gateway API

The gateway is private and is reached only through the paywall.

### 8.1 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/privacy/scan` | gateway key | scan |
| POST | `/v1/privacy/mask` | gateway key | mask |
| POST | `/v1/chat/completions` | gateway key | private chat |
| GET | `/v1/models` | gateway key | the current free pool plus `chainaim/auto` |
| GET | `/internal/capacity` | gateway key | `{ "chatAvailable": bool, "reason"?: string, "retryAfterSec"?: number }` |
| POST | `/v1/route/explain` | gateway key | the chat decision without a chat-model call (calls Jev); internal only |
| GET | `/healthz` | none | 200 when Presidio answered its last check (every 30 s), otherwise 503 |

### 8.2 Responses

scan:

```json
{
  "decisionId": "7d0c…",
  "dataClass": "PHI",
  "found": ["PHI", "PII"],
  "entities": [{ "type": "PERSON", "start": 8, "end": 16, "score": 0.85 }],
  "counts": { "PERSON": 1, "MEDICAL_RECORD": 1 },
  "policy": { "dataCollection": "deny", "cardDataRemoved": false }
}
```

mask: `{ decisionId, dataClass, found, maskedText, map, counts, cardsRemoved }`, where `map` looks like `{ "<PERSON_1>": "Jane Roe" }`.

chat: the OpenAI chat completion with values restored, plus the headers `x-chainaim-decision-id`, `x-chainaim-data-class`, `x-chainaim-classifier` (`jev` or `rules`), `x-chainaim-model` and `x-chainaim-attempts`.

### 8.3 Errors

The OpenAI error shape from the existing `sendError`:

| Status | When |
|---|---|
| 400 | invalid body, image parts present, text over the limit, pinned model not eligible |
| 413 | body over `--max-body-bytes` |
| 503 | Presidio down, no chat capacity, empty chain, every attempt failed, health data with no no-collection provider |

### 8.4 Ledger line

- scan and mask: `ts, decisionId, endpoint, dataClass, found, entityCounts, cardsRemoved, status, latencyMs, textChars`.
- chat adds: `classifier, task, difficulty, jev ({ probabilities, latencyMs } or null), dataCollection, chain, served, attempts[{ model, outcome, status, ms }], unresolvedPlaceholders, promptChars`.

## 9. Payments: the paywall

- **Stack:** Hono, `@hono/node-server`, `@x402/hono`, `@x402/core`, `@x402/avm` and `@x402-avm/extensions`, following `x402-demo/x402-examples/server/bazaar-integration` in the sibling folder.
- **Network** from `X402_NETWORK`: `testnet` is `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`; `mainnet` is `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` with USDC ASA 31566704. The facilitator is `https://facilitator.goplausible.xyz`. `payTo` comes from `AVM_PAY_TO`.
- **Paid routes:** scheme `exact`, one payTo address, tag `x402-global-challenge` (placement per V3).

| Route | Price | Bazaar description |
|---|---|---|
| POST `/v1/privacy/scan` | $0.002 | Finds personal, health and card data in text and returns entity types, positions and the data class. No model is called. |
| POST `/v1/privacy/mask` | $0.003 | Replaces personal and health identifiers with numbered placeholders and removes card numbers. Returns the masked text and the map to restore it. |
| POST `/v1/chat/completions` | $0.01 | OpenAI-compatible private chat. Masks the conversation, routes it with Jev across free models under a data policy set by what it contains, and restores the answer. |

- **Discovery:** each paid route declares `declareDiscoveryExtension` metadata with an input schema and synthetic examples only.
- **Free routes:** `GET /v1/models` and `GET /healthz`, proxied without payment.
- **Capacity guard:** registered before the payment middleware for `POST /v1/chat/completions`. It calls the gateway's `/internal/capacity`; when chat is unavailable it returns 503 with `Retry-After` and no 402, so nobody is asked to pay for a call that cannot be served.
- **Proxy:** forwards the method, path, `content-type` and body to `GATEWAY_URL` with the gateway key, removes `PAYMENT-SIGNATURE`, `X-PAYMENT` and any other payment headers, and streams the response back.
- **Settlement:** the middleware settles only responses below 400 (confirmed in the `@x402/hono` source), so every refusal in section 8.3 is free for the caller.
- **Payment log:** one JSON line to stdout per settled payment (section 5).

## 10. Configuration and deployment

### New gateway flags

| Flag | Default |
|---|---|
| `--model-source openrouter-free\|catalog` | `catalog` for tests and local runs; production uses `openrouter-free` |
| `--openrouter-key-env NAME` | `OPENROUTER_API_KEY` |
| `--presidio-url URL` | `http://127.0.0.1:5002` (the container's port 3000 mapped locally) |
| `--presidio-threshold N` | `0.4` |
| `--jev on\|off` | `on` |
| `--jev-model ID` | `typesafe/jev-1.13` |
| `--jev-timeout-ms N` | `800` |
| `--health-flag-threshold N` | `0.5` |
| `--free-sync-interval-ms N` | `21600000` (6 hours) |
| `--free-rpm N` | `20` |
| `--max-output-tokens N` | `1024` |

Existing flags keep their meaning. In `catalog` mode the static catalog's models form the pool, scored with the table or the defaults, so the stub models keep working for tests and local runs.

### Deployment on Railway

Fly.io works the same way, with three apps on its private network.

| Service | Source | Resources | Network | Environment |
|---|---|---|---|---|
| presidio | image `mcr.microsoft.com/presidio-analyzer`, pinned tag | 2 GB RAM | private, port 3000 | none |
| gateway | `services/gateway/Dockerfile` (Node 24) | 512 MB RAM, volume at `/data` | private, port 8700 | secrets `OPENROUTER_API_KEY`, `CHAINAIM_GATEWAY_KEY`; flags `--host :: --model-source openrouter-free --api-key-env CHAINAIM_GATEWAY_KEY --presidio-url http://presidio.railway.internal:3000 --ledger /data/ledger` |
| paywall | `services/paywall/Dockerfile` (Node 24) | 256 MB RAM | public HTTPS | `AVM_PAY_TO`, `X402_NETWORK`, `FACILITATOR_URL`, `GATEWAY_URL`, secret `CHAINAIM_GATEWAY_KEY` |

- Every service uses the restart policy "always".
- An external uptime monitor (UptimeRobot free tier) requests `/healthz` on the paywall's public domain every 5 minutes and emails on failure. The paywall proxies it to the gateway, which checks Presidio, so one monitor covers all three services.
- Expected cost is about $10 to $25 a month, mostly Presidio's memory.
- Buy $10 of OpenRouter credits before launch. That unlocks 1,000 free requests a day and pays for Jev.
- Only the payTo address is configured. It must be a MainNet account opted in to USDC.

## 11. Testing

All tests use real sockets, like the existing gateway tests, against stub servers:

- `scripts/stub-presidio.ts` returns entities for a fixed synthetic corpus.
- `scripts/stub-openrouter.ts` serves `/api/v1/models`, `/api/v1/key`, `/api/v1/chat/completions` and `/api/alpha/decisions`. It has modes for account 429, provider 429, data-policy 404, 401, 5xx and slow responses, and records every request body it receives.

### Launch gate (must pass before chat goes live)

1. **Leak:** across the synthetic corpus, no body received by the stub OpenRouter or the stub Jev contains an original identifier or a card number; every PHI request carries `data_collection: "deny"`; no PHI request reaches the stub Jev.
2. **Round trip:** masking and then restoring returns the original text for every corpus item, including tool-call arguments that contain quotes and backslashes.
3. **Ledger:** no original value, placeholder or map appears in any ledger line. This extends the existing synthetic-MRN test.

### Other tests

4. **Classification:** Jev success; Jev timeout, 5xx and malformed responses fall back to rules; the health flag upgrades a request to PHI.
5. **Selection:** each filter, the scoring order, a pinned model, and an empty chain returning 503.
6. **Limits:** the per-minute window; daily exhaustion making chat unavailable; an account 429 stopping the chain; a provider 429 moving on; a data-policy 404 caching the model.
7. **Cooldown:** a failed OpenRouter model is usable again after `--cooldown-ms`, with probes off.
8. **Fail closed:** Presidio down returns 503 on all three routes.
9. **Paywall**, with a stub facilitator that implements `/supported`, `/verify` and `/settle`: an unpaid request gets 402 with the price, network, payTo, tag and Bazaar extension; a paid request that the gateway answers with 503 never reaches `/settle`; the capacity guard answers 503 without a 402.
10. **Existing tests:** the route-engine tests stay unchanged. Gateway tests that assert the old profile behaviour are rewritten for the new decision shape, and the failing agentic test noted in `DEMO.md` goes with the retired profiles.

Manual end to end: TestNet first, with the `x402-demo` fetch client paying the deployed paywall, then MainNet with one real payment per route.

## 12. Schedule

| Date | Work | Done when |
|---|---|---|
| Fri Sep 25 | Presidio client, entities, classify, mask and restore; scan and mask routes; tests 1 to 3 and 8 for scan and mask | tests pass locally |
| Sat Sep 26 | Paywall; Railway deploy on TestNet; switch to MainNet | a real MainNet payment on scan and on mask; both listed in the Bazaar |
| Sun Sep 27 | Free pool, scoring table, selector, OpenRouter shaping, quota, cooldown fix, rules classifier, chat pipeline; tests 1 to 7 | the launch gate passes |
| Mon Sep 28 | Jev client and health flag; deploy chat | a real MainNet payment on chat; chat listed in the Bazaar |
| Tue Sep 29 | Update the submission text; submit before 11:45 pm EST | submitted |
| October | Measure detection recall on a synthetic set, tune the scoring table from the ledger, add true streaming restore | ongoing |

If the chat work slips, submit on Sep 29 with scan and mask live and describe chat as launching.

## 13. Risks and verification items

### Risks

| Risk | Mitigation |
|---|---|
| OpenRouter suspends the key (terms section 7) | Scan and mask keep working; chat refuses without charging; the capacity guard stops 402 challenges for chat |
| No free model has a no-collection provider | PHI chat is refused without charging; the ledger counts the refusals; the submission text states the rule as it is |
| The free lineup changes | 6-hourly sync; defaults for unknown models |
| 1,000 free requests a day caps chat volume | Scan and mask carry most of the volume; the capacity guard |
| The Decisions API is alpha | Pinned model id, strict parsing, rules fallback |
| Detection misses values | Threshold 0.4; recall measured in October; no compliance claims in the submission |

### Verification items

Each is the first step of the work that depends on it.

- **V1:** The Decisions API field names and casing (`type`, `instructions`, `criteria`, and `true` / `false` for noul questions) and the response shape, confirmed with one live call.
- **V2:** Whether `free_model_daily_requests` in `GET /api/v1/key` reports calls used or calls remaining.
- **V3:** Where the `x402-global-challenge` tag goes in the route configuration. The GoPlausible guide shows `extra: { tag }`.
- **V4:** The Presidio image lists IN_AADHAAR, IN_PAN, CREDIT_CARD, US_SSN, PERSON, EMAIL_ADDRESS, PHONE_NUMBER and MEDICAL_LICENSE in `/supportedentities`. If the Indian recognizers are missing, enable them with a recognizer configuration in a small derived image. The gateway refuses to start when a required entity is missing.
- **V5:** The exact error OpenRouter returns for the account-level free limits and for "no endpoints match your data policy", so the categories in section 7 match real responses.

## 14. Follow-up documents

- **Submission text:** replace "Health data only goes to models ChainAim hosts itself" with "Health data only goes to model providers that don't collect data; if none is available, the request is refused and the caller isn't charged". Describe routing as Jev classifying the masked request and a scoring table choosing among OpenRouter's free models.
- **`docs/adr/0002-openrouter-free-models-and-jev.md`:** record D2, D3 (with the terms risk) and D9.
- **`PROJECT_CONTEXT.md`:** update the status line and link this spec.
