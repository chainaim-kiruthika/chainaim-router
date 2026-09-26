# ChainAim Privacy Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship paid scan, mask and private-chat endpoints on Algorand MainNet (x402 through the GoPlausible facilitator, listed in the Bazaar) with Presidio masking and Jev-routed OpenRouter free models, as the approved design describes.

**Architecture:** A public Hono `paywall` (official x402 middleware) proxies paid calls to the private, zero-dependency Node `gateway`. The gateway masks text with a private Presidio analyzer before anything leaves ChainAim's containers. Chat classifies the masked conversation with Jev (rules fallback), ranks OpenRouter free models with a scoring table, calls them under a data policy, and restores placeholders in the answer.

**Tech Stack:** Node 24 (TypeScript run natively, `node:test`), Presidio analyzer 2.2.362 (Docker), OpenRouter chat + Decisions API, Hono 4.13.9, @hono/node-server 2.1.1, @x402/hono, @x402/core and @x402/avm 2.27.0, @x402-avm/extensions 2.6.1, Railway.

**Spec:** `docs/superpowers/specs/2026-09-24-privacy-gateway-design.md`. Read it before starting any task; this plan argues from it and cites its sections.

## Global Constraints

Every task's requirements include this section. Values are copied from the spec.

- Gateway: zero npm runtime dependencies (Node built-ins only) and no build step (Node runs the TypeScript). Use only erasable TypeScript: no `enum`, `namespace`, constructor parameter properties or `satisfies`. Import types with `type`. Use `.ts` extensions in relative imports.
- Node `>=22.22` (package engines); Docker images use `node:24-slim`.
- Never write request or response text, placeholders, the placeholder map, tool arguments or upstream error bodies to the ledger, logs or error messages.
- Fail closed: if Presidio is unreachable or returns an error, scan, mask and chat return 503. Text that has not been scanned is never sent anywhere.
- Limits: scan and mask take `{ "text": string }` of 1 to 20,000 characters. Chat takes at most 48,000 characters of message text. `max_tokens` (or `max_completion_tokens`) is capped at 1,024 and defaults to 1,024.
- Presidio score threshold 0.4. LOCATION, DATE_TIME, NRP and URL are never masked (not requested).
- Placeholders are `<TYPE_N>`, numbered per type from 1 in order of first appearance. Card numbers become `[CARD REMOVED]` and are never restored.
- PHI goes upstream only with `provider: { "data_collection": "deny" }`. Jev never sees a request already classed as PHI.
- Every chat answer comes from an OpenRouter model whose id ends in `:free`.
- Prices: scan `$0.002`, mask `$0.003`, chat `$0.01`. Scheme `exact`, one `payTo`, and `extra: { tag: "x402-global-challenge" }` on every `accepts` entry.
- Networks: testnet `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`; mainnet `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` (USDC ASA 31566704). Facilitator `https://facilitator.goplausible.xyz`.
- Every refusal has status 400 or above, so the payment is not settled. The gateway never returns 402.
- Tests, examples and Bazaar metadata use synthetic data only (`scripts/synthetic-corpus.ts`).
- Tests use real sockets on `127.0.0.1` port 0 and close every server in `after` hooks.
- End every commit message with a `Co-Authored-By:` trailer (pass it as a second `-m`): the attribution line your own environment gives you, or else `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as the commands in this plan show.

## Verification items (state on 2026-09-25)

| Item | State | What the plan does |
|---|---|---|
| V1 Decisions API shape | Docs and a public test harness agree: request `{ model, state, questions }`; each question has `type`, `instructions`, `criteria`; answers are `choice` + `probabilities`, `score` + `probabilities` keyed `"0"`..`"4"`, and `noul` (a number). A live call is pending (no key here). | `parseJevAnswers` accepts that shape strictly. `scripts/verify-openrouter.ts` (Task C5) runs the live call. |
| V2 key allowance | Resolved from OpenRouter's docs: `GET /api/v1/key` returns `free_model_daily_requests: { used, limit, remaining }`. | `Quota.refresh` reads `data.free_model_daily_requests.remaining`. |
| V3 tag placement | Resolved (GoPlausible guide and Algorand's troubleshooting post): `extra: { tag: "x402-global-challenge" }` on each `accepts` entry. Attribution is written at settlement, so the tag must be present before the first MainNet payment. | `routesConfig` sets it on every route; a paywall test checks the 402. |
| V4 Presidio entities | Presidio's default recognizer config ships `InAadhaarRecognizer` and `InPanRecognizer` with `enabled: false`. | `services/presidio` builds a derived image that enables them; the gateway refuses to start if a required entity is missing; `scripts/verify-presidio.ts` checks a running Presidio. |
| V5 OpenRouter errors | Docs: account and key limits are a 429 with no provider metadata; provider limits carry `metadata.provider_name`; the free-limit messages name `free-models-per-min` or `free-models-per-day`. "No provider meets your routing requirements" is now documented as 503; older responses used 404 "No endpoints found matching your data policy". | `categorize` handles all of these; `scripts/verify-openrouter.ts` records live data-policy refusals. |

## Refinements to the spec

These keep the spec's intent and close gaps found while planning. Mention them in the final report.

1. Chat forwards an allowlist of request fields (`PASSTHROUGH` in `openrouter.ts`) and rebuilds each message from `role`, `content`, `tool_calls` and `tool_call_id` only. This covers the spec's list of removed fields and also stops unscanned text in fields such as `name`, `prediction` or `reasoning` from leaving.
2. Every non-text content part (images, audio, files) gets 400, not only images.
3. Tool-call arguments that are JSON are masked value by value, with the key read by Presidio as context, then re-serialized. A masked value can then never break JSON escaping. Number values are scanned too; a masked number comes back as a string.
4. A 4xx caused by the request (400, 413, 422) does not cool a model down. Otherwise a caller whose payment is verified but never settled could cool every model down for free. 5xx, 408 and malformed 2xx answers do cool a model down. When every attempt fails, the caller gets the upstream status only for 400, 413 and 422, and 503 otherwise.
5. A 403 with moderation metadata is `upstream_error`, not `key_rejected`. `key_rejected` starts a key read at once, so a misread 403 cannot hold chat down for 10 minutes.
6. `data_policy_unavailable` matches a 404 or 503 whose message mentions the data policy or routing requirements.
7. A pinned model that is cooling down or has no no-collection provider gets 503 (a temporary state), not 400.
8. New flags: `--scores`, `--openrouter-base-url` (tests point it at the stub), `--presidio-timeout-ms`, `--presidio-wait-ms`, `--presidio-check-ms`, `--deny-cache-ms` and `--key-read-interval-ms`. The flags of the retired profiles are removed: `--strategy`, `--default-profile`, and `--default-max-tokens` (replaced by `--max-output-tokens`).
9. Presidio runs as a small derived image (`services/presidio`) from the start. It enables the Indian recognizers and binds `[::]` for Railway's private network.
10. The paywall takes an optional `PUBLIC_BASE_URL`, so 402 responses and the Bazaar list `https://` resource URLs behind Railway's TLS proxy.
11. Scan returns UTF-16 offsets (JavaScript string indices). Presidio's code-point offsets are converted.
12. The `Engine` class (routing profiles) and its tests are deleted in Task C9, because nothing calls them after D8.

## File map

| File | Task | Responsibility |
|---|---|---|
| `services/gateway/src/errors.ts` | A4 | `HttpError`: a status plus a client-safe message |
| `services/gateway/src/privacy/entities.ts` | A1 | Entity groups, health terms, ad-hoc recognizers, `Detected` type |
| `services/gateway/src/privacy/classify.ts` | A1 | Entity types to `found`, `dataClass` and policy; counts |
| `services/gateway/src/privacy/presidio.ts` | A2 | Presidio client, offset conversion, overlap resolution, start-up check |
| `services/gateway/src/privacy/mask.ts` | A3, C8 | `Masker` (placeholders, cards); conversation walker (C8) |
| `services/gateway/src/privacy/restore.ts` | A3 | Restore strings and completions, JSON-safe in tool arguments |
| `services/gateway/src/routing/freepool.ts` | C2 | Free model sync, `ModelSource`, OpenRouter deployments, catalog source |
| `services/gateway/src/routing/scores.ts` | C3 | Scoring table: load, validate, size defaults, score |
| `services/gateway/src/routing/select.ts` | C4 | Eligibility filters, ranking, deny-unavailable cache |
| `services/gateway/src/openrouter.ts` | C5 | Request shaping (allowlist) and failure categories |
| `services/gateway/src/dispatch.ts` | C5, C9 | One model attempt with timeout, health and category |
| `services/gateway/src/routing/quota.ts` | C6 | Per-minute window, daily allowance, pauses, `capacity()` |
| `services/gateway/src/routing/jev.ts` | C7 | Decisions API client and strict answer parsing |
| `services/gateway/src/routing/classify.ts` | C7 | Jev first, rules fallback: task, difficulty, health |
| `services/gateway/src/chat.ts` | C9 | The private chat pipeline, explain, SSE emulation |
| `services/gateway/src/server.ts` | A4, C1, C9 | Routes (section 8) |
| `services/gateway/src/pool.ts` | C1 | Cooldown fix, runtime model list, probes off for OpenRouter |
| `services/gateway/src/catalog.ts` | C1 | `probe?: boolean` on deployments |
| `services/gateway/src/ledger.ts` | A4, C9 | Ledger entry types (no text) |
| `services/gateway/src/main.ts` | A4, C1, C10 | Flags and wiring |
| `services/gateway/src/engine.ts` | C9 | Deleted (retired profiles) |
| `services/gateway/test/helpers.ts` | A4, C1, C9 | Shared test gateway set-up |
| `services/gateway/test/*.test.ts` | all | `privacy`, `presidio`, `scan-mask`, `pool`, `freepool`, `scores`, `select`, `openrouter`, `quota`, `jev`, `chat`, `gateway` |
| `config/free-models.json` | C3 | Scoring table seed (spec section 6) |
| `scripts/synthetic-corpus.ts` | A2 | Synthetic identifiers and corpus items |
| `scripts/stub-presidio.ts` | A2 | Stub Presidio (tests and local runs) |
| `scripts/stub-openrouter.ts` | C5 | Stub OpenRouter: models, key, chat, decisions |
| `scripts/verify-presidio.ts` | B3 | V4 check against a real Presidio |
| `scripts/verify-openrouter.ts` | C5 | V1, V2 and V5 checks against the real OpenRouter |
| `scripts/smoke.ts` | C10 | Smoke test for the new API |
| `services/paywall/**` | B1, B2, B4 | Paywall service, tests, payment client |
| `services/gateway/Dockerfile`, `services/paywall/Dockerfile`, `services/presidio/*` | B3, C10 | Images and Railway config |
| `docs/deploy/railway.md` | B3 | Deployment runbook |
| `docs/adr/0002-openrouter-free-models-and-jev.md`, `docs/submission.md` | C10 | Follow-up documents (spec section 14) |

Milestones (from the spec's schedule):

- **A, scan and mask** (Tasks A1 to A4): tests 1 to 3 and 8 pass for scan and mask.
- **B, paywall and deployment** (Tasks B1 to B4): a real MainNet payment on scan and on mask, and both listed in the Bazaar. The owner does the deploy and the payments; the tasks prepare everything.
- **C, private chat** (Tasks C1 to C10): the launch gate passes, then chat is deployed.

---

## Part A: scan and mask

### Task A1: Entity groups and data classes

**Files:**
- Create: `services/gateway/src/privacy/entities.ts`
- Create: `services/gateway/src/privacy/classify.ts`
- Test: `services/gateway/test/privacy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `entities.ts`: `type Detected = { type: string; start: number; end: number; score: number }`; `PERSONAL_ENTITIES`, `CARD_ENTITIES`, `MEDICAL_ID_ENTITIES` (readonly string tuples); `HEALTH_TERM = "HEALTH_TERM"`; `DETECTED_ENTITIES: readonly string[]`; `REQUIRED_PRESIDIO_ENTITIES: readonly string[]`; `isPersonal`, `isCard`, `isMedicalId`, `isHealthTerm`, `isMasked` (all `(type: string) => boolean`); `HEALTH_TERMS: readonly string[]`; `type AdHocRecognizer`; `AD_HOC_RECOGNIZERS: readonly AdHocRecognizer[]`.
  - `classify.ts`: `type DataClass = "PHI" | "PCI" | "PII" | "none"`; `type FoundClass = Exclude<DataClass, "none">`; `type Policy = { dataCollection: "allow" | "deny"; cardDataRemoved: boolean }`; `type Classes = { found: FoundClass[]; dataClass: DataClass; policy: Policy }`; `classify(types: Iterable<string>, healthFlag?: boolean): Classes`; `countTypes(entities: readonly { type: string }[]): Record<string, number>`.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/privacy.test.ts`:

```ts
/**
 * Privacy unit tests: entity groups, data classes, masking and restore.
 * All data is synthetic (scripts/synthetic-corpus.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, countTypes } from "../src/privacy/classify.ts";
import { AD_HOC_RECOGNIZERS, DETECTED_ENTITIES, HEALTH_TERMS, isMasked, REQUIRED_PRESIDIO_ENTITIES } from "../src/privacy/entities.ts";

describe("entity groups", () => {
  it("requires the built-in Presidio entities named in V4", () => {
    for (const e of ["IN_AADHAAR", "IN_PAN", "CREDIT_CARD", "US_SSN", "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "MEDICAL_LICENSE"]) {
      assert.ok(REQUIRED_PRESIDIO_ENTITIES.includes(e), e);
    }
  });

  it("never asks Presidio for locations, dates, NRP or URLs", () => {
    for (const e of ["LOCATION", "DATE_TIME", "NRP", "URL"]) assert.ok(!DETECTED_ENTITIES.includes(e), e);
  });

  it("masks personal data and medical IDs, but not cards or health terms", () => {
    assert.equal(isMasked("PERSON"), true);
    assert.equal(isMasked("US_NPI"), true);
    assert.equal(isMasked("CREDIT_CARD"), false);
    assert.equal(isMasked("HEALTH_TERM"), false);
  });

  it("sends MRN, NPI and health-term recognizers; the patterns need a context word", () => {
    const byEntity = new Map(AD_HOC_RECOGNIZERS.map((r) => [r.supported_entity, r]));
    for (const e of ["MEDICAL_RECORD", "US_NPI"]) {
      const r = byEntity.get(e)!;
      assert.ok(r.patterns!.every((p) => p.score < 0.4), `${e} alone stays below the 0.4 threshold`);
      assert.ok(r.context!.length > 0, `${e} has context words`);
    }
    assert.deepEqual(byEntity.get("HEALTH_TERM")!.deny_list, HEALTH_TERMS);
  });

  it("leaves ambiguous abbreviations out of the health terms", () => {
    for (const t of ["AIDS", "STD", "STI"]) assert.ok(!HEALTH_TERMS.includes(t), t);
  });
});

describe("classify", () => {
  type Want = { found: string[]; dataClass: string; dataCollection: string; cardDataRemoved: boolean };
  const cases: [string, string[], boolean, Want][] = [
    ["nothing found", [], false, { found: [], dataClass: "none", dataCollection: "allow", cardDataRemoved: false }],
    ["a name", ["PERSON"], false, { found: ["PII"], dataClass: "PII", dataCollection: "allow", cardDataRemoved: false }],
    ["a general medical question", ["HEALTH_TERM"], false, { found: [], dataClass: "none", dataCollection: "allow", cardDataRemoved: false }],
    ["a name and a condition", ["PERSON", "HEALTH_TERM"], false, { found: ["PHI", "PII"], dataClass: "PHI", dataCollection: "deny", cardDataRemoved: false }],
    ["a medical record number alone", ["MEDICAL_RECORD"], false, { found: ["PHI"], dataClass: "PHI", dataCollection: "deny", cardDataRemoved: false }],
    ["a card", ["CREDIT_CARD"], false, { found: ["PCI"], dataClass: "PCI", dataCollection: "allow", cardDataRemoved: true }],
    ["everything", ["CREDIT_CARD", "PERSON", "US_NPI"], false, { found: ["PHI", "PCI", "PII"], dataClass: "PHI", dataCollection: "deny", cardDataRemoved: true }],
    ["Jev's health flag", ["PERSON"], true, { found: ["PHI", "PII"], dataClass: "PHI", dataCollection: "deny", cardDataRemoved: false }],
  ];
  for (const [name, types, flag, want] of cases) {
    it(name, () => {
      const c = classify(types, flag);
      assert.deepEqual(
        { found: c.found, dataClass: c.dataClass, dataCollection: c.policy.dataCollection, cardDataRemoved: c.policy.cardDataRemoved },
        want,
      );
    });
  }

  it("counts occurrences per type", () => {
    assert.deepEqual(countTypes([{ type: "PERSON" }, { type: "PERSON" }, { type: "HEALTH_TERM" }]), { PERSON: 2, HEALTH_TERM: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/privacy.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/privacy/classify.ts`.

- [ ] **Step 3: Write the implementation**

Create `services/gateway/src/privacy/entities.ts`:

```ts
/**
 * What the gateway looks for, and how each kind of entity is treated (spec
 * section 5). Presidio supplies the built-in recognizers; MEDICAL_RECORD,
 * US_NPI and HEALTH_TERM come from the ad-hoc recognizers below, which are
 * sent with every /analyze request.
 */

/** One detected entity. Offsets are UTF-16 indices into the analysed text. */
export type Detected = { type: string; start: number; end: number; score: number };

/** Replaced with <TYPE_N> and restored in answers. */
export const PERSONAL_ENTITIES = [
  "PERSON",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "IN_AADHAAR",
  "IN_PAN",
  "US_SSN",
  "IP_ADDRESS",
  "IBAN_CODE",
  "US_PASSPORT",
  "US_DRIVER_LICENSE",
  "CRYPTO",
] as const;
/** Replaced with [CARD REMOVED] and never restored. Presidio checks the Luhn digit. */
export const CARD_ENTITIES = ["CREDIT_CARD"] as const;
/** Replaced with <TYPE_N>; any one of them makes the text PHI. */
export const MEDICAL_ID_ENTITIES = ["MEDICAL_LICENSE", "MEDICAL_RECORD", "US_NPI"] as const;
/** Conditions, drugs and procedures: left in place (the model needs them) and used only to classify. */
export const HEALTH_TERM = "HEALTH_TERM";

/** Entity types requested from Presidio. LOCATION, DATE_TIME, NRP and URL are left out on purpose. */
export const DETECTED_ENTITIES: readonly string[] = [...PERSONAL_ENTITIES, ...CARD_ENTITIES, ...MEDICAL_ID_ENTITIES, HEALTH_TERM];

/** Built-in Presidio entities the gateway refuses to run without (checked at start-up, V4). */
export const REQUIRED_PRESIDIO_ENTITIES: readonly string[] = [...PERSONAL_ENTITIES, ...CARD_ENTITIES, "MEDICAL_LICENSE"];

const PERSONAL = new Set<string>(PERSONAL_ENTITIES);
const MEDICAL_ID = new Set<string>(MEDICAL_ID_ENTITIES);

export const isPersonal = (type: string): boolean => PERSONAL.has(type);
export const isCard = (type: string): boolean => type === "CREDIT_CARD";
export const isMedicalId = (type: string): boolean => MEDICAL_ID.has(type);
export const isHealthTerm = (type: string): boolean => type === HEALTH_TERM;
/** Types that become numbered placeholders. */
export const isMasked = (type: string): boolean => PERSONAL.has(type) || MEDICAL_ID.has(type);

/**
 * ChainAim's health-term list, matched as whole words in any case. Ambiguous
 * abbreviations (AIDS, STD, STI) are left out: "std::vector" in a coding
 * question must not make a request PHI.
 */
export const HEALTH_TERMS: readonly string[] = [
  // conditions
  "diabetes", "diabetic", "hypertension", "high blood pressure", "asthma", "cancer", "tumor", "tumour",
  "leukemia", "lymphoma", "HIV", "hepatitis", "tuberculosis", "pneumonia", "COVID-19", "depression",
  "anxiety disorder", "bipolar disorder", "schizophrenia", "PTSD", "ADHD", "autism", "dementia",
  "Alzheimer's", "Parkinson's", "epilepsy", "seizure", "stroke", "heart attack", "heart failure",
  "arrhythmia", "chest pain", "migraine", "arthritis", "lupus", "multiple sclerosis", "kidney disease",
  "cirrhosis", "obesity", "pregnant", "pregnancy", "miscarriage", "infertility", "overdose", "addiction",
  "opioid use disorder", "eating disorder", "anorexia", "chlamydia", "syphilis", "herpes",
  // drugs
  "insulin", "metformin", "lisinopril", "atorvastatin", "amlodipine", "sertraline", "fluoxetine",
  "prozac", "xanax", "adderall", "oxycodone", "methadone", "buprenorphine", "warfarin", "prednisone",
  // procedures and care
  "chemotherapy", "radiotherapy", "dialysis", "biopsy", "mastectomy", "transplant", "surgery",
  "inhaler", "diagnosed", "diagnosis", "prescribed", "prescription",
];

export type AdHocRecognizer = {
  name: string;
  supported_language: "en";
  supported_entity: string;
  patterns?: { name: string; regex: string; score: number }[];
  context?: string[];
  deny_list?: readonly string[];
};

/**
 * Sent with every /analyze call. A pattern scored 0.1 passes the 0.4
 * threshold only when Presidio finds a context word near it (+0.35, floor
 * 0.4), which is how "needs a context word" is expressed.
 */
export const AD_HOC_RECOGNIZERS: readonly AdHocRecognizer[] = [
  {
    name: "ChainAim medical record number",
    supported_language: "en",
    supported_entity: "MEDICAL_RECORD",
    patterns: [{ name: "mrn (needs context)", regex: "\\b[A-Z]{0,3}\\d{6,10}\\b", score: 0.1 }],
    context: ["mrn", "medical", "record"],
  },
  {
    name: "ChainAim NPI",
    supported_language: "en",
    supported_entity: "US_NPI",
    patterns: [{ name: "npi (needs context)", regex: "\\b[12]\\d{9}\\b", score: 0.1 }],
    context: ["npi"],
  },
  { name: "ChainAim health terms", supported_language: "en", supported_entity: HEALTH_TERM, deny_list: HEALTH_TERMS },
];
```

Create `services/gateway/src/privacy/classify.ts`:

```ts
/**
 * Entity types -> data classes and the data policy (spec section 5, "Classes").
 */
import { isCard, isHealthTerm, isMedicalId, isPersonal } from "./entities.ts";

export type DataClass = "PHI" | "PCI" | "PII" | "none";
export type FoundClass = Exclude<DataClass, "none">;
export type Policy = { dataCollection: "allow" | "deny"; cardDataRemoved: boolean };
export type Classes = { found: FoundClass[]; dataClass: DataClass; policy: Policy };

/**
 * @param types entity types found in one text (scan, mask) or in a whole conversation (chat)
 * @param healthFlag Jev judged the chat to be about a specific person's health
 */
export function classify(types: Iterable<string>, healthFlag = false): Classes {
  let personal = false;
  let card = false;
  let medicalId = false;
  let healthTerm = false;
  for (const t of types) {
    personal ||= isPersonal(t);
    card ||= isCard(t);
    medicalId ||= isMedicalId(t);
    healthTerm ||= isHealthTerm(t);
  }
  const phi = medicalId || (healthTerm && personal) || healthFlag;
  const found: FoundClass[] = [];
  if (phi) found.push("PHI");
  if (card) found.push("PCI");
  if (personal) found.push("PII");
  return { found, dataClass: found[0] ?? "none", policy: { dataCollection: phi ? "deny" : "allow", cardDataRemoved: card } };
}

/** Occurrences per entity type, e.g. { PERSON: 2, HEALTH_TERM: 1 }. */
export function countTypes(entities: readonly { type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test services/gateway/test/privacy.test.ts`
Expected: PASS, 14 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/privacy/entities.ts services/gateway/src/privacy/classify.ts services/gateway/test/privacy.test.ts
git commit -m "feat(privacy): entity groups, health terms and data classes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task A2: Presidio client, synthetic corpus and stub Presidio

**Files:**
- Create: `scripts/synthetic-corpus.ts`
- Create: `scripts/stub-presidio.ts`
- Create: `services/gateway/src/privacy/presidio.ts`
- Test: `services/gateway/test/presidio.test.ts`
- Modify: `package.json` (add the `stub-presidio` script)

**Interfaces:**
- Consumes: `Detected`, `DETECTED_ENTITIES`, `AD_HOC_RECOGNIZERS`, `REQUIRED_PRESIDIO_ENTITIES` from Task A1.
- Produces:
  - `scripts/synthetic-corpus.ts`: `type KnownValue = { value: string; type: string }`; `KNOWN_VALUES: readonly KnownValue[]`; `type CorpusItem = { id: string; text: string; expect: { dataClass: string; found: string[] } }`; `CORPUS: readonly CorpusItem[]`.
  - `scripts/stub-presidio.ts`: `type StubPresidioMode = "ok" | "fail" | "malformed" | "missing-entities"`; `type StubPresidio = { url: string; mode: StubPresidioMode; requests: Record<string, unknown>[]; close(): Promise<void> }`; `STUB_SUPPORTED_ENTITIES: readonly string[]`; `stubDetect(text: string, denyList: readonly string[]): { entity_type: string; start: number; end: number; score: number }[]` (code-point offsets); `startStubPresidio(port?: number, host?: string): Promise<StubPresidio>`.
  - `presidio.ts`: `class PresidioError extends Error`; `type PresidioOptions = { url: string; threshold: number; timeoutMs: number; concurrency?: number }`; `class PresidioClient { readonly url: string; healthy: boolean; analyze(text: string): Promise<Detected[]>; analyzeAll(texts: readonly string[]): Promise<Detected[][]>; supportedEntities(): Promise<string[]>; checkHealth(): Promise<boolean>; start(intervalMs: number): void; stop(): void }`; `postProcess(text: string, found: readonly Detected[]): Detected[]` (code points to UTF-16, trim, resolve overlaps); `resolveOverlaps(spans: readonly Detected[]): Detected[]`; `waitForPresidio(presidio: PresidioClient, waitMs: number, pauseMs?: number): Promise<void>`.

- [ ] **Step 1: Write the synthetic corpus**

Create `scripts/synthetic-corpus.ts`:

```ts
/**
 * SYNTHETIC privacy corpus. Every name, number and address below is
 * invented. The stub Presidio (scripts/stub-presidio.ts) "detects" exactly
 * these values, so tests can prove that none of them ever reaches a model,
 * Jev or the ledger. Never add real data here.
 */
export type KnownValue = { value: string; type: string };

export const KNOWN_VALUES: readonly KnownValue[] = [
  { value: "Jane Roe", type: "PERSON" },
  { value: 'Jane "JR" Roe', type: "PERSON" },
  { value: "Arjun Mehta", type: "PERSON" },
  { value: "Priya Sharma", type: "PERSON" },
  { value: "Tom Baker", type: "PERSON" },
  { value: "Alan Grant", type: "PERSON" },
  { value: "Maria Garcia", type: "PERSON" },
  { value: "jane.roe@example.com", type: "EMAIL_ADDRESS" },
  { value: "+1 415 555 0132", type: "PHONE_NUMBER" },
  { value: "2345 6789 0123", type: "IN_AADHAAR" },
  { value: "ABCPE1234F", type: "IN_PAN" },
  { value: "078-05-1120", type: "US_SSN" },
  { value: "912803456", type: "US_PASSPORT" },
  { value: "D1234567", type: "US_DRIVER_LICENSE" },
  { value: "192.168.10.45", type: "IP_ADDRESS" },
  { value: "DE89370400440532013000", type: "IBAN_CODE" },
  { value: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", type: "CRYPTO" },
  { value: "4111 1111 1111 1111", type: "CREDIT_CARD" },
  { value: "5500005555555559", type: "CREDIT_CARD" },
  { value: "AB1234563", type: "MEDICAL_LICENSE" },
  { value: "991122", type: "MEDICAL_RECORD" },
  { value: "1234567893", type: "US_NPI" },
];

export type CorpusItem = { id: string; text: string; expect: { dataClass: string; found: string[] } };

export const CORPUS: readonly CorpusItem[] = [
  { id: "phi-mrn", text: "Patient Jane Roe, MRN 991122, was diagnosed with diabetes last spring.", expect: { dataClass: "PHI", found: ["PHI", "PII"] } },
  { id: "pii-contact", text: "Email jane.roe@example.com or call +1 415 555 0132 about invoice 7781.", expect: { dataClass: "PII", found: ["PII"] } },
  { id: "pci-card", text: "Card 4111 1111 1111 1111 was charged $42 for Arjun Mehta.", expect: { dataClass: "PCI", found: ["PCI", "PII"] } },
  { id: "pii-india", text: "Aadhaar 2345 6789 0123 and PAN ABCPE1234F belong to Priya Sharma.", expect: { dataClass: "PII", found: ["PII"] } },
  { id: "pii-us", text: "SSN 078-05-1120 for Tom Baker; passport 912803456; licence D1234567.", expect: { dataClass: "PII", found: ["PII"] } },
  { id: "phi-npi", text: "Dr. Alan Grant (NPI 1234567893, DEA AB1234563) prescribed metformin.", expect: { dataClass: "PHI", found: ["PHI", "PII"] } },
  {
    id: "pii-network",
    text: "Wire from IBAN DE89370400440532013000, login from 192.168.10.45, refund to 1BoatSLRHtKNngkdXEeobR76b53LETtpyT.",
    expect: { dataClass: "PII", found: ["PII"] },
  },
  { id: "none-health", text: "What are the common early symptoms of asthma?", expect: { dataClass: "none", found: [] } },
  { id: "none-plain", text: "Summarize the plot of Hamlet in two sentences.", expect: { dataClass: "none", found: [] } },
  { id: "pii-repeat", text: "Jane Roe met Maria Garcia; later Jane Roe emailed jane.roe@example.com.", expect: { dataClass: "PII", found: ["PII"] } },
  { id: "phi-emoji", text: "🙂 Thanks, Jane Roe! Your asthma inhaler refill is ready.", expect: { dataClass: "PHI", found: ["PHI", "PII"] } },
  { id: "pci-only", text: "Refund card 5500005555555559 please.", expect: { dataClass: "PCI", found: ["PCI"] } },
  { id: "phi-quoted", text: 'Ship to Jane "JR" Roe, file C:\\records\\991122.txt.', expect: { dataClass: "PHI", found: ["PHI", "PII"] } },
];
```

- [ ] **Step 2: Write the stub Presidio**

Create `scripts/stub-presidio.ts`:

```ts
/**
 * Stub Presidio analyzer, for tests and local runs without Docker. It
 * "detects" the synthetic corpus values (scripts/synthetic-corpus.ts) and any
 * deny-list terms sent as ad-hoc recognizers, and reports offsets in code
 * points, like the real (Python) service.
 *
 *   node scripts/stub-presidio.ts [--port 5002]
 *
 * Modes (set `mode` on the handle, or GET /admin/mode?m=...):
 *   ok | fail (every route answers 500) | malformed (entities without offsets)
 *   | missing-entities (/supportedentities leaves out IN_AADHAAR)
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { KNOWN_VALUES } from "./synthetic-corpus.ts";

export type StubPresidioMode = "ok" | "fail" | "malformed" | "missing-entities";
export type StubPresidio = { url: string; mode: StubPresidioMode; requests: Record<string, unknown>[]; close: () => Promise<void> };
type Found = { entity_type: string; start: number; end: number; score: number };

export const STUB_SUPPORTED_ENTITIES: readonly string[] = [
  "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "IN_AADHAAR", "IN_PAN", "US_SSN", "IP_ADDRESS", "IBAN_CODE",
  "US_PASSPORT", "US_DRIVER_LICENSE", "CRYPTO", "CREDIT_CARD", "MEDICAL_LICENSE", "LOCATION", "DATE_TIME", "NRP", "URL",
];

const codePoints = (text: string, utf16: number): number => [...text.slice(0, utf16)].length;

function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/** What the stub finds in one text: corpus values anywhere, deny-list terms as whole words in any case. */
export function stubDetect(text: string, denyList: readonly string[]): Found[] {
  const found: Found[] = [];
  const add = (type: string, i: number, length: number, score: number): void => {
    found.push({ entity_type: type, start: codePoints(text, i), end: codePoints(text, i + length), score });
  };
  for (const { value, type } of KNOWN_VALUES) for (const i of occurrences(text, value)) add(type, i, value.length, 0.85);
  const lower = text.toLowerCase();
  for (const term of denyList) {
    const t = term.toLowerCase();
    for (const i of occurrences(lower, t)) {
      if (/\w/.test(lower[i - 1] ?? "") || /\w/.test(lower[i + t.length] ?? "")) continue;
      add("HEALTH_TERM", i, t.length, 1);
    }
  }
  return found;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function startStubPresidio(port = 0, host = "127.0.0.1"): Promise<StubPresidio> {
  const stub = { url: "", mode: "ok", requests: [], close: async () => {} } as StubPresidio;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.local");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (url.pathname === "/admin/mode") {
      stub.mode = (url.searchParams.get("m") ?? "ok") as StubPresidioMode;
      return json(res, 200, { mode: stub.mode });
    }
    if (stub.mode === "fail") return json(res, 500, { error: "stub: forced failure" });
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Presidio Analyzer service is up");
      return;
    }
    if (req.method === "GET" && url.pathname === "/supportedentities") {
      return json(res, 200, stub.mode === "missing-entities" ? STUB_SUPPORTED_ENTITIES.filter((e) => e !== "IN_AADHAAR") : STUB_SUPPORTED_ENTITIES);
    }
    if (req.method === "POST" && url.pathname === "/analyze") {
      const body = JSON.parse(raw) as { text?: unknown; entities?: string[]; ad_hoc_recognizers?: { deny_list?: string[] }[] };
      stub.requests.push(body as Record<string, unknown>);
      if (!body.text) return json(res, 500, { error: "No text provided" }); // like the real service
      const deny = (body.ad_hoc_recognizers ?? []).flatMap((r) => r.deny_list ?? []);
      const one = (text: string): unknown[] => {
        if (stub.mode === "malformed") return [{ entity_type: "PERSON", score: 0.85 }];
        return stubDetect(text, deny).filter((e) => !body.entities || body.entities.includes(e.entity_type));
      };
      return json(res, 200, Array.isArray(body.text) ? body.text.map((t) => one(String(t))) : one(String(body.text)));
    }
    json(res, 404, { error: `stub: no route ${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      stub.url = `http://${host}:${(server.address() as AddressInfo).port}`;
      stub.close = () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
      resolve(stub);
    });
  });
}

if (import.meta.main ?? process.argv[1]?.endsWith("stub-presidio.ts")) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "5002" }, host: { type: "string", default: "127.0.0.1" } } });
  const stub = await startStubPresidio(Number(values.port), values.host);
  console.log(`[stub-presidio] ${stub.url}  (synthetic corpus only; GET /admin/mode?m=ok|fail|malformed|missing-entities)`);
}
```

In `package.json`, add to `"scripts"` (after `"stub-models"`):

```json
    "stub-presidio": "node scripts/stub-presidio.ts",
```

- [ ] **Step 3: Write the failing test**

Create `services/gateway/test/presidio.test.ts`:

```ts
/**
 * Presidio client: offsets, overlaps, fail closed, and the start-up check (V4).
 * Runs against the stub Presidio over a real socket.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { AD_HOC_RECOGNIZERS, DETECTED_ENTITIES } from "../src/privacy/entities.ts";
import { PresidioClient, PresidioError, postProcess, resolveOverlaps, waitForPresidio } from "../src/privacy/presidio.ts";

describe("resolveOverlaps", () => {
  it("keeps the longer of two overlapping spans", () => {
    const kept = resolveOverlaps([
      { type: "PERSON", start: 0, end: 4, score: 0.9 },
      { type: "HEALTH_TERM", start: 0, end: 11, score: 0.5 },
    ]);
    assert.deepEqual(kept.map((s) => s.type), ["HEALTH_TERM"]);
  });

  it("breaks an equal-length tie by score", () => {
    const kept = resolveOverlaps([
      { type: "US_DRIVER_LICENSE", start: 5, end: 13, score: 0.4 },
      { type: "MEDICAL_RECORD", start: 5, end: 13, score: 0.45 },
    ]);
    assert.deepEqual(kept.map((s) => s.type), ["MEDICAL_RECORD"]);
  });

  it("keeps spans that don't overlap, sorted by start", () => {
    const kept = resolveOverlaps([
      { type: "EMAIL_ADDRESS", start: 20, end: 30, score: 1 },
      { type: "PERSON", start: 0, end: 8, score: 0.85 },
    ]);
    assert.deepEqual(kept.map((s) => s.start), [0, 20]);
  });
});

describe("postProcess", () => {
  it("converts Presidio's code-point offsets to UTF-16 around an emoji", () => {
    const text = "🙂 Thanks, Jane Roe!";
    // Presidio counts the emoji as one character, so "Jane Roe" starts at code point 10.
    const [d] = postProcess(text, [{ type: "PERSON", start: 10, end: 18, score: 0.85 }]);
    assert.equal(text.slice(d.start, d.end), "Jane Roe");
  });

  it("trims whitespace at the edges of a span", () => {
    const [d] = postProcess("Hi  Jane Roe ", [{ type: "PERSON", start: 2, end: 13, score: 0.9 }]);
    assert.deepEqual([d.start, d.end], [4, 12]);
  });

  it("rejects an offset outside the text", () => {
    assert.throws(() => postProcess("abc", [{ type: "PERSON", start: 1, end: 9, score: 1 }]), PresidioError);
  });
});

describe("PresidioClient against the stub", () => {
  let stub: StubPresidio;
  let client: PresidioClient;
  before(async () => {
    stub = await startStubPresidio();
    client = new PresidioClient({ url: stub.url, threshold: 0.4, timeoutMs: 2000 });
  });
  after(() => stub.close());
  afterEach(() => {
    stub.mode = "ok";
  });

  it("finds corpus values and health terms with UTF-16 offsets", async () => {
    const text = "🙂 Thanks, Jane Roe! Your asthma inhaler refill is ready.";
    const found = await client.analyze(text);
    assert.deepEqual(
      found.map((e) => [e.type, text.slice(e.start, e.end)]),
      [["PERSON", "Jane Roe"], ["HEALTH_TERM", "asthma"], ["HEALTH_TERM", "inhaler"]],
    );
  });

  it("sends the threshold, the language, the entity list and the ad-hoc recognizers", async () => {
    stub.requests.length = 0;
    await client.analyze("Call Jane Roe.");
    const sent = stub.requests[0];
    assert.equal(sent.language, "en");
    assert.equal(sent.score_threshold, 0.4);
    assert.deepEqual(sent.entities, DETECTED_ENTITIES);
    assert.deepEqual(sent.ad_hoc_recognizers, AD_HOC_RECOGNIZERS);
  });

  it("does not call Presidio for blank text", async () => {
    stub.requests.length = 0;
    assert.deepEqual(await client.analyze("   "), []);
    assert.equal(stub.requests.length, 0);
  });

  it("analyzeAll keeps the input order", async () => {
    const [a, b, c] = await client.analyzeAll(["Tom Baker", "", "Maria Garcia and Tom Baker"]);
    assert.deepEqual([a.length, b.length, c.length], [1, 0, 2]);
  });

  it("fails closed: a Presidio error is a PresidioError and marks it unhealthy", async () => {
    stub.mode = "fail";
    await assert.rejects(client.analyze("Jane Roe"), PresidioError);
    assert.equal(client.healthy, false);
  });

  it("rejects a malformed entity instead of skipping it", async () => {
    stub.mode = "malformed";
    await assert.rejects(client.analyze("Jane Roe"), PresidioError);
  });

  it("checkHealth follows /health", async () => {
    assert.equal(await client.checkHealth(), true);
    stub.mode = "fail";
    assert.equal(await client.checkHealth(), false);
  });

  it("waitForPresidio passes when every required entity is supported", async () => {
    await waitForPresidio(client, 1000, 10);
  });

  it("waitForPresidio refuses to start when a required entity is missing", async () => {
    stub.mode = "missing-entities";
    await assert.rejects(waitForPresidio(client, 1000, 10), /IN_AADHAAR/);
  });
});

describe("waitForPresidio without a Presidio", () => {
  it("gives up after waitMs", async () => {
    const client = new PresidioClient({ url: "http://127.0.0.1:9", threshold: 0.4, timeoutMs: 200 });
    await assert.rejects(waitForPresidio(client, 100, 20), /did not answer/);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test services/gateway/test/presidio.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/privacy/presidio.ts`.

- [ ] **Step 5: Write the Presidio client**

Create `services/gateway/src/privacy/presidio.ts`:

```ts
/**
 * Presidio analyzer client. Presidio runs on ChainAim's private network, and
 * no text goes anywhere else until Presidio's answer has been used to mask
 * it. Every failure is a PresidioError, which the routes turn into 503 (fail
 * closed).
 */
import { AD_HOC_RECOGNIZERS, DETECTED_ENTITIES, REQUIRED_PRESIDIO_ENTITIES, type Detected } from "./entities.ts";

export class PresidioError extends Error {}

export type PresidioOptions = {
  url: string;
  /** Minimum entity score (spec: 0.4). */
  threshold: number;
  timeoutMs: number;
  /** Parallel /analyze calls when a conversation has several texts. */
  concurrency?: number;
};

export class PresidioClient {
  readonly url: string;
  /** Result of the last health check or call; /healthz reports it. */
  healthy = false;
  private readonly opts: PresidioOptions;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: PresidioOptions) {
    this.opts = opts;
    this.url = opts.url.replace(/\/+$/, "");
  }

  /** Entities in `text`: UTF-16 offsets, whitespace trimmed, overlaps resolved, sorted by start. */
  async analyze(text: string): Promise<Detected[]> {
    if (text.trim() === "") return []; // Presidio rejects empty text, and there is nothing to find
    const raw = await this.call("/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        language: "en",
        score_threshold: this.opts.threshold,
        entities: DETECTED_ENTITIES,
        ad_hoc_recognizers: AD_HOC_RECOGNIZERS,
      }),
    });
    if (!Array.isArray(raw)) throw this.fail("/analyze returned an unexpected shape");
    return postProcess(text, raw.map((r) => this.parseResult(r)));
  }

  /** analyze() for several texts, a few calls at a time; results keep the input order. */
  analyzeAll(texts: readonly string[]): Promise<Detected[][]> {
    return mapLimit(texts, this.opts.concurrency ?? 4, (t) => this.analyze(t));
  }

  async supportedEntities(): Promise<string[]> {
    const raw = await this.call("/supportedentities?language=en");
    if (!Array.isArray(raw) || !raw.every((e) => typeof e === "string")) throw this.fail("/supportedentities returned an unexpected shape");
    return raw as string[];
  }

  /** GET /health; updates `healthy`. */
  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      await res.body?.cancel();
      this.healthy = res.ok;
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.checkHealth(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private parseResult(r: unknown): Detected {
    const o = r as { entity_type?: unknown; start?: unknown; end?: unknown; score?: unknown } | null;
    const start = o?.start;
    const end = o?.end;
    if (typeof o?.entity_type !== "string" || !Number.isInteger(start) || !Number.isInteger(end) || typeof o.score !== "number" || (start as number) < 0 || (end as number) < (start as number)) {
      // Skipping a malformed entity could leave a value unmasked, so the whole call fails.
      throw this.fail("/analyze returned a malformed entity");
    }
    return { type: o.entity_type, start: start as number, end: end as number, score: o.score };
  }

  private fail(message: string): PresidioError {
    this.healthy = false;
    return new PresidioError(`presidio ${message}`);
  }

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      throw this.fail(`${path}: ${(e as Error).name}`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw this.fail(`${path}: HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw this.fail(`${path}: the response is not JSON`);
    }
    this.healthy = true;
    return body;
  }
}

/**
 * Presidio (Python) counts code points; JavaScript strings count UTF-16 units.
 * Convert, trim whitespace at span edges, and resolve overlaps.
 */
export function postProcess(text: string, found: readonly Detected[]): Detected[] {
  const toUtf16 = utf16Index(text);
  const spans: Detected[] = [];
  for (const d of found) {
    let start = toUtf16(d.start);
    let end = toUtf16(d.end);
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end > start) spans.push({ type: d.type, start, end, score: d.score });
  }
  return resolveOverlaps(spans);
}

function utf16Index(text: string): (codePoint: number) => number {
  if (!/[\uD800-\uDFFF]/.test(text)) {
    return (cp) => {
      if (cp > text.length) throw new PresidioError(`presidio offset ${cp} is outside the text`);
      return cp;
    };
  }
  const units: number[] = [];
  let u = 0;
  for (const ch of text) {
    units.push(u);
    u += ch.length;
  }
  units.push(u);
  return (cp) => {
    const i = units[cp];
    if (i === undefined) throw new PresidioError(`presidio offset ${cp} is outside the text`);
    return i;
  };
}

/** Overlapping spans: the longer wins; on equal length, the higher score. The result is sorted by start. */
export function resolveOverlaps(spans: readonly Detected[]): Detected[] {
  const ranked = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || b.score - a.score || a.start - b.start);
  const kept: Detected[] = [];
  for (const s of ranked) {
    if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Start-up check (V4): wait until Presidio answers, then refuse to run if a
 * required built-in entity is missing. A missing entity fails at once; an
 * unreachable Presidio is retried every pauseMs until waitMs runs out.
 */
export async function waitForPresidio(presidio: PresidioClient, waitMs: number, pauseMs = 2000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let supported: string[];
    try {
      supported = await presidio.supportedEntities();
    } catch (e) {
      if (Date.now() + pauseMs > deadline) throw new Error(`Presidio at ${presidio.url} did not answer within ${waitMs} ms (${(e as Error).message})`);
      await new Promise((r) => setTimeout(r, pauseMs));
      continue;
    }
    const have = new Set(supported);
    const missing = REQUIRED_PRESIDIO_ENTITIES.filter((e) => !have.has(e));
    if (missing.length > 0) {
      throw new Error(`Presidio at ${presidio.url} does not support ${missing.join(", ")}; deploy services/presidio, which enables them`);
    }
    return;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test services/gateway/test/presidio.test.ts services/gateway/test/privacy.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add scripts/synthetic-corpus.ts scripts/stub-presidio.ts services/gateway/src/privacy/presidio.ts services/gateway/test/presidio.test.ts package.json
git commit -m "feat(privacy): Presidio client with fail-closed errors, stub Presidio and synthetic corpus" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task A3: Masking and restore

**Files:**
- Create: `services/gateway/src/privacy/mask.ts`
- Create: `services/gateway/src/privacy/restore.ts`
- Create: `services/gateway/test/helpers.ts` (`withCardsRemoved`, shared with the scan and mask tests in Task A4)
- Modify: `services/gateway/test/privacy.test.ts` (append two suites)

**Interfaces:**
- Consumes: `Detected`, `isCard`, `isMasked`, `HEALTH_TERMS` (A1); `postProcess` (A2); `CORPUS`, `KNOWN_VALUES`, `stubDetect` (A2).
- Produces:
  - `mask.ts`: `CARD_REMOVED = "[CARD REMOVED]"`; `class Masker { readonly map: Record<string, string>; cardsRemoved: number; mask(text: string, entities: readonly Detected[]): string }`.
  - `restore.ts`: `type RestoreStats = { unresolved: number }`; `restoreText(text: string, map: Readonly<Record<string, string>>, stats: RestoreStats, json?: boolean): string`; `restoreCompletion(completion: unknown, map: Readonly<Record<string, string>>, stats: RestoreStats): void`.
  - `test/helpers.ts`: `withCardsRemoved(text: string): string` (a corpus text as restore gives it back: card numbers stay `[CARD REMOVED]`).

- [ ] **Step 1: Write the failing tests**

Create `services/gateway/test/helpers.ts` (Task A4 adds the gateway set-up to this file):

```ts
/**
 * Shared test helpers.
 */
import { KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { CARD_REMOVED } from "../src/privacy/mask.ts";

/** A corpus text as restore gives it back: card numbers stay removed. */
export function withCardsRemoved(text: string): string {
  let out = text;
  for (const k of KNOWN_VALUES) if (k.type === "CREDIT_CARD") out = out.replaceAll(k.value, CARD_REMOVED);
  return out;
}
```

Append to `services/gateway/test/privacy.test.ts`. Add these imports at the top of the file, below the existing imports:

```ts
import { CORPUS, KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { stubDetect } from "../../../scripts/stub-presidio.ts";
import { Masker } from "../src/privacy/mask.ts";
import { postProcess } from "../src/privacy/presidio.ts";
import { restoreCompletion, restoreText } from "../src/privacy/restore.ts";
import { withCardsRemoved } from "./helpers.ts";
```

Then append at the end of the file:

```ts
/** What PresidioClient.analyze would return for `text` against the stub. */
function detect(text: string) {
  const found = stubDetect(text, HEALTH_TERMS).map((f) => ({ type: f.entity_type, start: f.start, end: f.end, score: f.score }));
  return postProcess(text, found);
}

describe("Masker", () => {
  it("numbers each type from 1, reuses a placeholder for the same value and keeps health terms", () => {
    const text = "Jane Roe met Maria Garcia; later Jane Roe emailed jane.roe@example.com about asthma.";
    const m = new Masker();
    assert.equal(m.mask(text, detect(text)), "<PERSON_1> met <PERSON_2>; later <PERSON_1> emailed <EMAIL_ADDRESS_1> about asthma.");
    assert.deepEqual(m.map, { "<PERSON_1>": "Jane Roe", "<PERSON_2>": "Maria Garcia", "<EMAIL_ADDRESS_1>": "jane.roe@example.com" });
  });

  it("shares numbering across texts in reading order", () => {
    const m = new Masker();
    assert.equal(m.mask("Hi Tom Baker", detect("Hi Tom Baker")), "Hi <PERSON_1>");
    assert.equal(m.mask("Tom Baker and Alan Grant", detect("Tom Baker and Alan Grant")), "<PERSON_1> and <PERSON_2>");
  });

  it("compares emails ignoring case", () => {
    const m = new Masker();
    const spans = [
      { type: "EMAIL_ADDRESS", start: 0, end: 20, score: 1 },
      { type: "EMAIL_ADDRESS", start: 25, end: 45, score: 1 },
    ];
    assert.equal(m.mask("jane.roe@example.com and JANE.ROE@EXAMPLE.COM", spans), "<EMAIL_ADDRESS_1> and <EMAIL_ADDRESS_1>");
  });

  it("removes cards for good: no placeholder, not in the map", () => {
    const text = "Card 4111 1111 1111 1111 was charged $42 for Arjun Mehta.";
    const m = new Masker();
    assert.equal(m.mask(text, detect(text)), "Card [CARD REMOVED] was charged $42 for <PERSON_1>.");
    assert.equal(m.cardsRemoved, 1);
    assert.deepEqual(m.map, { "<PERSON_1>": "Arjun Mehta" });
  });
});

describe("restore", () => {
  it("restores placeholders in any case, with spaces inside the brackets", () => {
    const stats = { unresolved: 0 };
    assert.equal(restoreText("Dear < person_1 >, see <PERSON_1>.", { "<PERSON_1>": "Jane Roe" }, stats), "Dear Jane Roe, see Jane Roe.");
    assert.equal(stats.unresolved, 0);
  });

  it("leaves an unknown placeholder alone and counts it", () => {
    const stats = { unresolved: 0 };
    assert.equal(restoreText("Hi <PERSON_9>", { "<PERSON_1>": "Jane Roe" }, stats), "Hi <PERSON_9>");
    assert.equal(stats.unresolved, 1);
  });

  it("JSON-escapes values inside tool-call arguments", () => {
    const map = { "<PERSON_1>": 'Jane "JR" Roe', "<MEDICAL_RECORD_1>": "C:\\records\\991122" };
    const args = restoreText('{"who":"<PERSON_1>","path":"<MEDICAL_RECORD_1>"}', map, { unresolved: 0 }, true);
    assert.deepEqual(JSON.parse(args), { who: 'Jane "JR" Roe', path: "C:\\records\\991122" });
  });

  it("restores content, reasoning, refusal and tool-call arguments of every choice", () => {
    const completion = {
      choices: [
        {
          message: {
            content: "Hello <PERSON_1>",
            reasoning: "<PERSON_1> asked",
            refusal: "not for <PERSON_1>",
            tool_calls: [{ function: { name: "lookup", arguments: '{"q":"<PERSON_1>"}' } }],
          },
        },
      ],
    };
    const stats = { unresolved: 0 };
    restoreCompletion(completion, { "<PERSON_1>": 'Jane "JR" Roe' }, stats);
    const m = completion.choices[0].message;
    assert.equal(m.content, 'Hello Jane "JR" Roe');
    assert.equal(m.reasoning, 'Jane "JR" Roe asked');
    assert.equal(m.refusal, 'not for Jane "JR" Roe');
    assert.deepEqual(JSON.parse(m.tool_calls[0].function.arguments), { q: 'Jane "JR" Roe' });
  });

  describe("launch gate 2: masking then restoring returns the original text", () => {
    for (const item of CORPUS) {
      it(item.id, () => {
        const m = new Masker();
        const masked = m.mask(item.text, detect(item.text));
        for (const { value } of KNOWN_VALUES) assert.ok(!masked.includes(value), `${value} is still in the masked text`);
        assert.equal(restoreText(masked, m.map, { unresolved: 0 }), withCardsRemoved(item.text));
      });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/privacy.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/privacy/mask.ts` (imported by the test and by `helpers.ts`).

- [ ] **Step 3: Write the implementation**

Create `services/gateway/src/privacy/mask.ts`:

```ts
/**
 * Masking: replace detected values with numbered placeholders the caller can
 * restore, and remove card numbers for good (spec section 5, "Placeholders").
 */
import { isCard, isMasked, type Detected } from "./entities.ts";

export const CARD_REMOVED = "[CARD REMOVED]";

/**
 * One Masker per request. Numbering and the map are shared by every text it
 * masks, so call mask() in reading order (messages in order, left to right).
 * The same value (after trimming; emails ignoring case) always gets the same
 * placeholder, and the map records the first spelling seen. The map lives
 * only as long as this object.
 */
export class Masker {
  /** placeholder -> original value */
  readonly map: Record<string, string> = {};
  cardsRemoved = 0;
  private readonly byValue = new Map<string, string>();
  private readonly lastNumber = new Map<string, number>();

  /** @param entities non-overlapping and sorted by start, as PresidioClient.analyze returns them */
  mask(text: string, entities: readonly Detected[]): string {
    let out = "";
    let at = 0;
    for (const e of entities) {
      const value = text.slice(e.start, e.end);
      out += text.slice(at, e.start);
      if (isCard(e.type)) {
        out += CARD_REMOVED;
        this.cardsRemoved++;
      } else if (isMasked(e.type)) {
        out += this.placeholder(e.type, value);
      } else {
        out += value; // health terms stay: the model needs them
      }
      at = e.end;
    }
    return out + text.slice(at);
  }

  private placeholder(type: string, value: string): string {
    const trimmed = value.trim();
    const key = `${type}\u0000${type === "EMAIL_ADDRESS" ? trimmed.toLowerCase() : trimmed}`;
    let p = this.byValue.get(key);
    if (p === undefined) {
      const n = (this.lastNumber.get(type) ?? 0) + 1;
      this.lastNumber.set(type, n);
      p = `<${type}_${n}>`;
      this.byValue.set(key, p);
      this.map[p] = value;
    }
    return p;
  }
}
```

Create `services/gateway/src/privacy/restore.ts`:

```ts
/**
 * Restore: put the original values back in place of <TYPE_N> placeholders
 * (spec section 5, "Restore"). A placeholder with no map entry stays as it is
 * and is counted, so the ledger shows how often a model invents one.
 */

/** <TYPE_N>, in any case, with spaces allowed inside the brackets. */
const PLACEHOLDER = /<\s*([A-Za-z][A-Za-z_]*?_\d+)\s*>/g;

export type RestoreStats = { unresolved: number };

/** @param json the text is inside a JSON string (tool-call arguments), so values are JSON-escaped */
export function restoreText(text: string, map: Readonly<Record<string, string>>, stats: RestoreStats, json = false): string {
  return text.replace(PLACEHOLDER, (whole: string, name: string) => {
    const value = map[`<${name.toUpperCase()}>`];
    if (value === undefined) {
      stats.unresolved++;
      return whole;
    }
    return json ? JSON.stringify(value).slice(1, -1) : value;
  });
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Restore a chat completion in place: content, reasoning, refusal and tool-call arguments of every choice. */
export function restoreCompletion(completion: unknown, map: Readonly<Record<string, string>>, stats: RestoreStats): void {
  const choices = isObj(completion) ? completion.choices : undefined;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const message = isObj(choice) ? choice.message : undefined;
    if (!isObj(message)) continue;
    for (const field of ["content", "reasoning", "refusal"]) {
      const v = message[field];
      if (typeof v === "string") message[field] = restoreText(v, map, stats);
    }
    if (!Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const fn = isObj(call) ? call.function : undefined;
      if (isObj(fn) && typeof fn.arguments === "string") fn.arguments = restoreText(fn.arguments, map, stats, true);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test services/gateway/test/privacy.test.ts`
Expected: PASS (14 earlier tests + 4 Masker + 4 restore + 13 round-trip = 35), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/privacy/mask.ts services/gateway/src/privacy/restore.ts services/gateway/test/helpers.ts services/gateway/test/privacy.test.ts
git commit -m "feat(privacy): placeholder masking, card removal and JSON-safe restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task A4: Scan and mask routes, Presidio health and the ledger

**Files:**
- Create: `services/gateway/src/errors.ts`
- Modify: `services/gateway/src/server.ts` (replace the whole file)
- Modify: `services/gateway/src/ledger.ts` (replace the whole file)
- Modify: `services/gateway/src/main.ts` (replace the whole file)
- Modify: `services/gateway/test/helpers.ts` (replace the whole file; Task A3's `withCardsRemoved` stays)
- Test: `services/gateway/test/scan-mask.test.ts`
- Modify: `services/gateway/test/gateway.test.ts` (new `createGateway` signature; stub Presidio; drop the retired agentic-profile test)
- Modify: `README.md`, `DEMO.md`

**Interfaces:**
- Consumes: `classify`, `countTypes` (A1); `PresidioClient`, `PresidioError`, `waitForPresidio` (A2); `Masker` (A3); `startStubPresidio`, `CORPUS`, `KNOWN_VALUES` (A2); `restoreText`, `CARD_REMOVED` (A3).
- Produces:
  - `errors.ts`: `class HttpError extends Error { status: number; headers: Record<string, string>; constructor(status: number, message: string, headers?: Record<string, string>) }`.
  - `server.ts`: `MAX_TEXT_CHARS = 20_000`; `type GatewayDeps = { engine: Engine; pool: Pool; ledger: Ledger; presidio: PresidioClient }` (Task C9 replaces `engine`); `createGateway(deps: GatewayDeps, opts: ServerOptions): Server`.
  - `ledger.ts`: `type PrivacyEntry` and `type LedgerEntry = RoutedEntry | PrivacyEntry`.
  - `test/helpers.ts` (keeps `withCardsRemoved` from Task A3): `listen(server: Server): Promise<string>`; `closeServer(server: Server): Promise<void>`; `type TestGateway = { url: string; server: Server; presidio: PresidioClient; ledgerDir: string; close(): Promise<void> }`; `startTestGateway(opts: { presidioUrl: string; gatewayKey?: string }): Promise<TestGateway>`; `post(url: string, body: unknown, headers?: Record<string, string>): Promise<Response>`; `ledgerText(dir: string): string`.

- [ ] **Step 1: Write the shared test helpers**

Replace `services/gateway/test/helpers.ts` (it keeps Task A3's `withCardsRemoved`):

```ts
/**
 * Shared test helpers: corpus expectations, and a gateway on a loopback
 * port talking to the stub Presidio, with its own temporary ledger directory.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { loadCatalog } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { Ledger } from "../src/ledger.ts";
import { Pool } from "../src/pool.ts";
import { CARD_REMOVED } from "../src/privacy/mask.ts";
import { PresidioClient } from "../src/privacy/presidio.ts";
import { createGateway } from "../src/server.ts";

/** A corpus text as restore gives it back: card numbers stay removed. */
export function withCardsRemoved(text: string): string {
  let out = text;
  for (const k of KNOWN_VALUES) if (k.type === "CREDIT_CARD") out = out.replaceAll(k.value, CARD_REMOVED);
  return out;
}

export type TestGateway = { url: string; server: Server; presidio: PresidioClient; ledgerDir: string; close: () => Promise<void> };

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

export async function startTestGateway(opts: { presidioUrl: string; gatewayKey?: string }): Promise<TestGateway> {
  const catalog = loadCatalog("config/catalog.json");
  const presidio = new PresidioClient({ url: opts.presidioUrl, threshold: 0.4, timeoutMs: 2000 });
  await presidio.checkHealth();
  const ledgerDir = mkdtempSync(join(tmpdir(), "chainaim-ledger-"));
  const server = createGateway(
    {
      engine: new Engine(catalog, { strategy: "rules", defaultProfile: "auto", defaultMaxTokens: 256 }),
      pool: new Pool(catalog, { healthIntervalMs: 0, healthTimeoutMs: 1000, unhealthyAfter: 1, cooldownMs: 60_000, env: {} }),
      ledger: new Ledger(ledgerDir),
      presidio,
    },
    { maxAttempts: 3, attemptTimeoutMs: 2000, maxBodyBytes: 1 << 20, gatewayKey: opts.gatewayKey },
  );
  const url = await listen(server);
  return { url, server, presidio, ledgerDir, close: () => closeServer(server) };
}

export const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Every ledger line written so far in `dir`, as raw text. */
export function ledgerText(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("");
}
```

- [ ] **Step 2: Write the failing route tests**

Create `services/gateway/test/scan-mask.test.ts`:

```ts
/**
 * Scan and mask over real sockets, against the stub Presidio and the
 * synthetic corpus: classes, placeholders, the 400/413/503 refusals, the
 * Presidio-driven /healthz, and a ledger with no text (launch gate 3).
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { CORPUS, KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { restoreText } from "../src/privacy/restore.ts";
import { ledgerText, post, startTestGateway, withCardsRemoved, type TestGateway } from "./helpers.ts";

describe("scan and mask", () => {
  let stub: StubPresidio;
  let g: TestGateway;
  before(async () => {
    stub = await startStubPresidio();
    g = await startTestGateway({ presidioUrl: stub.url });
  });
  after(async () => {
    await g.close();
    await stub.close();
  });
  afterEach(() => {
    stub.mode = "ok";
  });

  for (const item of CORPUS) {
    it(`scan classifies ${item.id}`, async () => {
      const r = await post(`${g.url}/v1/privacy/scan`, { text: item.text });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.dataClass, item.expect.dataClass);
      assert.deepEqual(j.found, item.expect.found);
      assert.equal(j.policy.dataCollection, item.expect.dataClass === "PHI" ? "deny" : "allow");
      assert.equal(r.headers.get("x-chainaim-decision-id"), j.decisionId);
      for (const e of j.entities) assert.ok(e.end > e.start && typeof e.score === "number" && typeof e.type === "string");
    });

    it(`mask hides every value in ${item.id} and restores exactly`, async () => {
      const j = await (await post(`${g.url}/v1/privacy/mask`, { text: item.text })).json();
      for (const { value } of KNOWN_VALUES) assert.ok(!j.maskedText.includes(value), `${value} leaked`);
      assert.equal(restoreText(j.maskedText, j.map, { unresolved: 0 }), withCardsRemoved(item.text));
    });
  }

  it("returns the numbered placeholders, the map and the counts", async () => {
    const j = await (await post(`${g.url}/v1/privacy/mask`, { text: "Jane Roe met Maria Garcia; later Jane Roe emailed jane.roe@example.com." })).json();
    assert.equal(j.maskedText, "<PERSON_1> met <PERSON_2>; later <PERSON_1> emailed <EMAIL_ADDRESS_1>.");
    assert.deepEqual(j.map, { "<PERSON_1>": "Jane Roe", "<PERSON_2>": "Maria Garcia", "<EMAIL_ADDRESS_1>": "jane.roe@example.com" });
    assert.deepEqual(j.counts, { PERSON: 3, EMAIL_ADDRESS: 1 });
    assert.equal(j.cardsRemoved, 0);
  });

  it("removes card numbers and never puts them in the map", async () => {
    const j = await (await post(`${g.url}/v1/privacy/mask`, { text: "Card 4111 1111 1111 1111 was charged $42 for Arjun Mehta." })).json();
    assert.equal(j.maskedText, "Card [CARD REMOVED] was charged $42 for <PERSON_1>.");
    assert.equal(j.cardsRemoved, 1);
    assert.deepEqual(j.map, { "<PERSON_1>": "Arjun Mehta" });
  });

  it("rejects missing, empty, non-string and oversized text with 400", async () => {
    for (const body of [{}, { text: "" }, { text: 42 }, { text: "x".repeat(20_001) }, []]) {
      assert.equal((await post(`${g.url}/v1/privacy/scan`, body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
  });

  it("rejects a body over the size limit with 413", async () => {
    assert.equal((await post(`${g.url}/v1/privacy/mask`, { text: "x".repeat(1_100_000) })).status, 413);
  });

  it("fails closed: with Presidio down, scan and mask answer 503 without echoing the text", async () => {
    stub.mode = "fail";
    for (const path of ["/v1/privacy/scan", "/v1/privacy/mask"]) {
      const r = await post(`${g.url}${path}`, { text: "Jane Roe" });
      assert.equal(r.status, 503);
      assert.ok(!(await r.text()).includes("Jane"), "the error does not echo the text");
    }
  });

  it("healthz follows Presidio's last check", async () => {
    await g.presidio.checkHealth();
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200);
    stub.mode = "fail";
    await g.presidio.checkHealth();
    const down = await fetch(`${g.url}/healthz`);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { status: "privacy_scanner_unavailable" });
    stub.mode = "ok";
    await g.presidio.checkHealth();
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200);
  });

  it("launch gate 3: no identifier, placeholder or map in the ledger", () => {
    // Every test above wrote ledger lines through this gateway.
    const text = ledgerText(g.ledgerDir);
    assert.ok(text.length > 0);
    for (const { value } of KNOWN_VALUES) assert.ok(!text.includes(value), `${value} is in the ledger`);
    assert.ok(!/<[A-Z_]+_\d+>/.test(text), "a placeholder is in the ledger");
    for (const line of text.trim().split("\n")) {
      const e = JSON.parse(line);
      assert.ok(["scan", "mask"].includes(e.endpoint));
      assert.equal(typeof e.textChars, "number");
      for (const k of ["text", "maskedText", "map", "entities"]) assert.ok(!(k in e), `${k} is in a ledger line`);
    }
  });
});

describe("scan and mask behind the gateway key", () => {
  let stub: StubPresidio;
  let g: TestGateway;
  before(async () => {
    stub = await startStubPresidio();
    g = await startTestGateway({ presidioUrl: stub.url, gatewayKey: "test-key-123" });
  });
  after(async () => {
    await g.close();
    await stub.close();
  });

  it("needs the key; /healthz stays open", async () => {
    assert.equal((await post(`${g.url}/v1/privacy/scan`, { text: "hi" })).status, 401);
    assert.equal((await post(`${g.url}/v1/privacy/scan`, { text: "hi" }, { authorization: "Bearer test-key-123" })).status, 200);
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test services/gateway/test/scan-mask.test.ts`
Expected: FAIL (the current `createGateway` takes `(engine, pool, ledger, opts)`, so the helper's call throws, and `/v1/privacy/scan` does not exist).

- [ ] **Step 4: Add `HttpError`**

Create `services/gateway/src/errors.ts`:

```ts
/**
 * HttpError: a failure the caller should see, with its HTTP status. The
 * message is sent to the client, so it must never contain request text.
 */
export class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
```

- [ ] **Step 5: Replace `services/gateway/src/ledger.ts`**

```ts
/**
 * Decision ledger: one JSON line per request.
 *
 * It records classes, counts, sizes, the routing decision and every attempt.
 * It never records request or response text, placeholders or the placeholder
 * map, so the file is not a copy of sensitive data.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Attempt } from "./dispatch.ts";
import type { Decision, RequestFeatures } from "./engine.ts";
import type { DataClass, FoundClass } from "./privacy/classify.ts";

/** A chat request routed by profile (retired in Task C9). */
export type RoutedEntry = {
  ts: string;
  decisionId: string;
  requestedModel?: string;
  decision: Omit<Decision, "reasoning"> & { reasoning?: string };
  request: Pick<RequestFeatures, "maxOutputTokens" | "hasTools" | "requiresTools" | "hasVision" | "requiresStructuredOutput" | "promptChars"> & { stream: boolean };
  served?: { model: string; deployment: string };
  attempts: Attempt[];
  status: number;
  latencyMs: number;
};

/** A scan or mask call: what was found, never the text. */
export type PrivacyEntry = {
  ts: string;
  decisionId: string;
  endpoint: "scan" | "mask";
  dataClass?: DataClass;
  found?: FoundClass[];
  entityCounts?: Record<string, number>;
  cardsRemoved?: number;
  status: number;
  latencyMs: number;
  textChars: number;
};

export type LedgerEntry = RoutedEntry | PrivacyEntry;

export class Ledger {
  private readonly dir: string | undefined;

  /** @param dir directory for daily files, or undefined to disable */
  constructor(dir: string | undefined) {
    this.dir = dir;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get enabled(): boolean {
    return this.dir !== undefined;
  }

  write(entry: LedgerEntry): void {
    if (!this.dir) return;
    const file = join(this.dir, `decisions-${entry.ts.slice(0, 10)}.jsonl`);
    // Synchronous append keeps lines whole under concurrency; volume is one small line per request.
    appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  }
}
```

- [ ] **Step 6: Replace `services/gateway/src/server.ts`**

```ts
/**
 * ChainAim gateway HTTP surface (OpenAI-compatible).
 *
 *   POST /v1/privacy/scan       entities and data class; no model is called
 *   POST /v1/privacy/mask       masked text and the placeholder map
 *   POST /v1/chat/completions   route + dispatch (stream or not)
 *   POST /v1/route/explain      decision only, nothing is sent to a model
 *   GET  /v1/models             catalog models + chainaim/* routing profiles
 *   GET  /v1/deployments        per-deployment health (authenticated)
 *   GET  /healthz               200 when Presidio answered its last check (unauthenticated)
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { PROFILES } from "./catalog.ts";
import { dispatch, type DispatchOptions } from "./dispatch.ts";
import { PROFILE_PREFIX, RequestError, type ChatRequest, type Engine } from "./engine.ts";
import { HttpError } from "./errors.ts";
import type { Ledger } from "./ledger.ts";
import type { Pool } from "./pool.ts";
import { classify, countTypes } from "./privacy/classify.ts";
import type { Detected } from "./privacy/entities.ts";
import { Masker } from "./privacy/mask.ts";
import { PresidioError, type PresidioClient } from "./privacy/presidio.ts";

/** Scan and mask accept a text of 1 to this many characters. */
export const MAX_TEXT_CHARS = 20_000;

export type GatewayDeps = { engine: Engine; pool: Pool; ledger: Ledger; presidio: PresidioClient };

export type ServerOptions = DispatchOptions & {
  maxBodyBytes: number;
  /** Bearer token clients must send; undefined = no gateway auth (bind to localhost only). */
  gatewayKey: string | undefined;
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { message, type: status >= 500 ? "gateway_error" : "invalid_request_error", code: status } }, headers);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function authorized(req: IncomingMessage, key: string | undefined): boolean {
  if (!key) return true;
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createGateway(deps: GatewayDeps, opts: ServerOptions): Server {
  const { engine, pool, ledger, presidio } = deps;
  const models = () => [
    ...PROFILES.map((p) => ({ id: `${PROFILE_PREFIX}${p}`, object: "model", owned_by: "chainaim", kind: "routing-profile" })),
    ...engine.catalog.models.map((m) => ({ id: m.id, object: "model", owned_by: m.zone, kind: "model", deployments: m.deployments.length })),
  ];

  /** scan and mask (spec section 4): detect, classify, and for mask replace. */
  async function privacy(kind: "scan" | "mask", req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const decisionId = randomUUID();
    const body = await readJson(req, opts.maxBodyBytes);
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_CHARS) {
      throw new HttpError(400, `text: a string of 1 to ${MAX_TEXT_CHARS} characters is required`);
    }
    const headers = { "x-chainaim-decision-id": decisionId };
    const entry = { ts: new Date().toISOString(), decisionId, endpoint: kind, textChars: text.length };
    const latencyMs = () => Math.round(performance.now() - started);

    let entities: Detected[];
    try {
      entities = await presidio.analyze(text);
    } catch (e) {
      if (!(e instanceof PresidioError)) throw e;
      ledger.write({ ...entry, status: 503, latencyMs: latencyMs() });
      sendError(res, 503, "the privacy scanner is unavailable; try again shortly", headers);
      return;
    }
    const classes = classify(entities.map((e) => e.type));
    const counts = countTypes(entities);
    const found = { dataClass: classes.dataClass, found: classes.found, entityCounts: counts };

    if (kind === "scan") {
      sendJson(res, 200, { decisionId, dataClass: classes.dataClass, found: classes.found, entities, counts, policy: classes.policy }, headers);
      ledger.write({ ...entry, ...found, cardsRemoved: 0, status: 200, latencyMs: latencyMs() });
      return;
    }
    const masker = new Masker();
    const maskedText = masker.mask(text, entities);
    sendJson(
      res,
      200,
      { decisionId, dataClass: classes.dataClass, found: classes.found, maskedText, map: masker.map, counts, cardsRemoved: masker.cardsRemoved },
      headers,
    );
    ledger.write({ ...entry, ...found, cardsRemoved: masker.cardsRemoved, status: 200, latencyMs: latencyMs() });
  }

  async function chat(req: IncomingMessage, res: ServerResponse, explainOnly: boolean): Promise<void> {
    const started = performance.now();
    const decisionId = randomUUID();
    const body = (await readJson(req, opts.maxBodyBytes)) as ChatRequest;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "request body must be a JSON object");

    const { decision, features } = engine.decide(body, pool.unavailableModels());
    const base = { "x-chainaim-decision-id": decisionId };
    if (explainOnly) {
      sendJson(res, 200, { decisionId, decision, request: { ...features, prompt: undefined, systemPrompt: undefined } }, base);
      return;
    }

    const clientAbort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) clientAbort.abort();
    });
    const result = await dispatch(decision.chain, body, pool, opts, clientAbort.signal);
    const entryBase = {
      ts: new Date().toISOString(),
      decisionId,
      requestedModel: body.model,
      decision,
      request: {
        maxOutputTokens: features.maxOutputTokens,
        hasTools: features.hasTools,
        requiresTools: features.requiresTools,
        hasVision: features.hasVision,
        requiresStructuredOutput: features.requiresStructuredOutput,
        promptChars: features.promptChars,
        stream: body.stream === true,
      },
    };

    if (!result.ok) {
      ledger.write({ ...entryBase, attempts: result.attempts, status: result.status, latencyMs: Math.round(performance.now() - started) });
      if (result.status !== 499) sendError(res, result.status, result.message, { ...base, "x-chainaim-attempts": String(result.attempts.length) });
      return;
    }

    const upstream = result.response;
    const headers: Record<string, string> = {
      ...base,
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-chainaim-model": result.model,
      "x-chainaim-deployment": result.deployment.id,
      "x-chainaim-attempts": String(result.attempts.length),
    };
    if (decision.tier) headers["x-chainaim-tier"] = decision.tier;
    if (decision.profile) headers["x-chainaim-profile"] = decision.profile;
    res.writeHead(upstream.status, headers);

    let ok = true;
    let error: string | undefined;
    try {
      if (upstream.body) {
        const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
        for await (const chunk of stream) {
          if (clientAbort.signal.aborted) break;
          res.write(chunk);
        }
      }
      res.end();
    } catch (e) {
      ok = false;
      error = `stream: ${(e as Error).message}`;
      res.destroy();
    } finally {
      result.done(ok, error);
      ledger.write({
        ...entryBase,
        served: { model: result.model, deployment: result.deployment.id },
        attempts: result.attempts,
        status: ok ? upstream.status : 502,
        latencyMs: Math.round(performance.now() - started),
      });
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        // Unauthenticated: says only whether Presidio answered its last check.
        sendJson(res, presidio.healthy ? 200 : 503, { status: presidio.healthy ? "ok" : "privacy_scanner_unavailable" });
        return;
      }
      if (!authorized(req, opts.gatewayKey)) {
        sendError(res, 401, "missing or invalid gateway API key");
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/privacy/scan") {
        await privacy("scan", req, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/privacy/mask") {
        await privacy("mask", req, res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/deployments") {
        sendJson(res, 200, { unavailableModels: pool.unavailableModels(), deployments: pool.status() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, { object: "list", data: models() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await chat(req, res, false);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/route/explain") {
        await chat(req, res, true);
        return;
      }
      sendError(res, 404, `no route for ${req.method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof HttpError) sendError(res, e.status, e.message, e.headers);
      else if (e instanceof RequestError) sendError(res, e.status, e.message);
      else {
        console.error(`[chainaim-gateway] ${req.method} ${url.pathname}:`, e);
        sendError(res, 500, "internal gateway error");
      }
    }
  });
}
```

- [ ] **Step 7: Replace `services/gateway/src/main.ts`**

```ts
/**
 * chainaim-gateway: entry point.
 *
 *   node services/gateway/src/main.ts --catalog config/catalog.json [flags]
 *
 * Every behaviour is a flag with a default; nothing is hard-coded elsewhere.
 */
import { parseArgs } from "node:util";
import { loadCatalog, PROFILES, type Profile } from "./catalog.ts";
import { Engine, type Strategy } from "./engine.ts";
import { Ledger } from "./ledger.ts";
import { Pool } from "./pool.ts";
import { PresidioClient, waitForPresidio } from "./privacy/presidio.ts";
import { createGateway } from "./server.ts";

const USAGE = `chainaim-gateway [flags]

  --catalog PATH             model catalog JSON                         (default config/catalog.json)
  --host HOST                bind address                               (default 127.0.0.1)
  --port N                   listen port                                (default 8700)
  --strategy rules|portfolio route-engine strategy                      (default rules)
  --default-profile P        profile when the request names no model    (default auto; auto|eco|premium)
  --default-max-tokens N     output budget assumed when unset           (default 1024)
  --max-attempts N           dispatch attempts per request              (default 3)
  --attempt-timeout-ms N     wait for upstream response headers         (default 60000)
  --health-interval-ms N     deployment health probe period, 0 = off    (default 10000)
  --health-timeout-ms N      per-probe timeout                          (default 3000)
  --unhealthy-after N        consecutive failures before cooldown       (default 2)
  --cooldown-ms N            how long a failed deployment sits out      (default 30000)
  --presidio-url URL         Presidio analyzer                          (default http://127.0.0.1:5002)
  --presidio-threshold N     minimum entity score, 0 to 1               (default 0.4)
  --presidio-timeout-ms N    per Presidio call                          (default 10000)
  --presidio-wait-ms N       how long start-up waits for Presidio       (default 120000)
  --presidio-check-ms N      Presidio health check period               (default 30000)
  --ledger DIR|off           decision ledger directory                  (default data/ledger)
  --max-body-bytes N         request size limit                         (default 4194304)
  --api-key-env NAME         env var holding the gateway bearer key     (default none = no auth)
  --help`;

function int(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got ${value}`);
  return n;
}

function num(name: string, value: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number from ${min} to ${max}, got ${value}`);
  return n;
}

export function parseFlags(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      catalog: { type: "string", default: "config/catalog.json" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8700" },
      strategy: { type: "string", default: "rules" },
      "default-profile": { type: "string", default: "auto" },
      "default-max-tokens": { type: "string", default: "1024" },
      "max-attempts": { type: "string", default: "3" },
      "attempt-timeout-ms": { type: "string", default: "60000" },
      "health-interval-ms": { type: "string", default: "10000" },
      "health-timeout-ms": { type: "string", default: "3000" },
      "unhealthy-after": { type: "string", default: "2" },
      "cooldown-ms": { type: "string", default: "30000" },
      "presidio-url": { type: "string", default: "http://127.0.0.1:5002" },
      "presidio-threshold": { type: "string", default: "0.4" },
      "presidio-timeout-ms": { type: "string", default: "10000" },
      "presidio-wait-ms": { type: "string", default: "120000" },
      "presidio-check-ms": { type: "string", default: "30000" },
      ledger: { type: "string", default: "data/ledger" },
      "max-body-bytes": { type: "string", default: String(4 * 1024 * 1024) },
      "api-key-env": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.strategy !== "rules" && values.strategy !== "portfolio") throw new Error("--strategy must be rules or portfolio");
  if (!(PROFILES as readonly string[]).includes(values["default-profile"]!)) throw new Error(`--default-profile must be one of ${PROFILES.join(", ")}`);
  if (!URL.canParse(values["presidio-url"]!)) throw new Error("--presidio-url must be a URL");
  return {
    help: values.help!,
    catalog: values.catalog!,
    host: values.host!,
    port: int("port", values.port!, 0),
    strategy: values.strategy as Strategy,
    defaultProfile: values["default-profile"] as Profile,
    defaultMaxTokens: int("default-max-tokens", values["default-max-tokens"]!, 1),
    maxAttempts: int("max-attempts", values["max-attempts"]!, 1),
    attemptTimeoutMs: int("attempt-timeout-ms", values["attempt-timeout-ms"]!, 1),
    healthIntervalMs: int("health-interval-ms", values["health-interval-ms"]!, 0),
    healthTimeoutMs: int("health-timeout-ms", values["health-timeout-ms"]!, 1),
    unhealthyAfter: int("unhealthy-after", values["unhealthy-after"]!, 1),
    cooldownMs: int("cooldown-ms", values["cooldown-ms"]!, 0),
    presidioUrl: values["presidio-url"]!,
    presidioThreshold: num("presidio-threshold", values["presidio-threshold"]!, 0, 1),
    presidioTimeoutMs: int("presidio-timeout-ms", values["presidio-timeout-ms"]!, 1),
    presidioWaitMs: int("presidio-wait-ms", values["presidio-wait-ms"]!, 0),
    presidioCheckMs: int("presidio-check-ms", values["presidio-check-ms"]!, 0),
    ledgerDir: values.ledger === "off" ? undefined : values.ledger!,
    maxBodyBytes: int("max-body-bytes", values["max-body-bytes"]!, 1024),
    apiKeyEnv: values["api-key-env"],
  };
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  if (f.help) {
    console.log(USAGE);
    return;
  }
  const gatewayKey = f.apiKeyEnv ? process.env[f.apiKeyEnv] : undefined;
  if (f.apiKeyEnv && !gatewayKey) throw new Error(`--api-key-env ${f.apiKeyEnv} is set but the variable is empty`);
  if (!gatewayKey && f.host !== "127.0.0.1" && f.host !== "::1" && f.host !== "localhost") {
    throw new Error("refusing to listen on a non-loopback address without --api-key-env");
  }

  // Refuse to start without a Presidio that detects every required entity (V4).
  const presidio = new PresidioClient({ url: f.presidioUrl, threshold: f.presidioThreshold, timeoutMs: f.presidioTimeoutMs });
  await waitForPresidio(presidio, f.presidioWaitMs);
  presidio.start(f.presidioCheckMs);

  const catalog = loadCatalog(f.catalog);
  const engine = new Engine(catalog, { strategy: f.strategy, defaultProfile: f.defaultProfile, defaultMaxTokens: f.defaultMaxTokens });
  const pool = new Pool(catalog, {
    healthIntervalMs: f.healthIntervalMs,
    healthTimeoutMs: f.healthTimeoutMs,
    unhealthyAfter: f.unhealthyAfter,
    cooldownMs: f.cooldownMs,
    env: process.env,
  });
  const ledger = new Ledger(f.ledgerDir);
  await pool.checkAll();
  pool.start();

  const server = createGateway(
    { engine, pool, ledger, presidio },
    { maxAttempts: f.maxAttempts, attemptTimeoutMs: f.attemptTimeoutMs, maxBodyBytes: f.maxBodyBytes, gatewayKey },
  );
  server.listen(f.port, f.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : f.port;
    const down = pool.unavailableModels();
    console.log(
      `[chainaim-gateway] listening on http://${f.host}:${port}  catalog=${catalog.version} models=${catalog.models.length} ` +
        `strategy=${f.strategy} presidio=${presidio.url} ledger=${ledger.enabled ? f.ledgerDir : "off"} auth=${gatewayKey ? "on" : "off"}` +
        (down.length ? `  unavailable=${down.join(",")}` : ""),
    );
  });
  const shutdown = () => {
    pool.stop();
    presidio.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main ?? process.argv[1]?.endsWith("main.ts")) {
  main().catch((e) => {
    console.error(`[chainaim-gateway] ${(e as Error).message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 8: Update the existing gateway tests for the new signature**

In `services/gateway/test/gateway.test.ts`:

1. Add these imports below the existing imports:

```ts
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { PresidioClient } from "../src/privacy/presidio.ts";
```

2. Replace the whole `startGateway` function with:

```ts
/** Set by the socket suite's before(); every gateway uses the stub Presidio. */
let presidioUrl = "";

async function startGateway(catalog: Catalog, extra: Partial<{ attemptTimeoutMs: number; gatewayKey: string; ledgerDir: string }> = {}) {
  const engine = new Engine(catalog, { strategy: "rules", defaultProfile: "auto", defaultMaxTokens: 256 });
  const pool = new Pool(catalog, { healthIntervalMs: 0, healthTimeoutMs: 1000, unhealthyAfter: 1, cooldownMs: 60_000, env: {} });
  const presidio = new PresidioClient({ url: presidioUrl, threshold: 0.4, timeoutMs: 2000 });
  await presidio.checkHealth();
  const server = createGateway({ engine, pool, ledger: new Ledger(extra.ledgerDir), presidio }, {
    maxAttempts: 3, attemptTimeoutMs: extra.attemptTimeoutMs ?? 5000, maxBodyBytes: 1 << 20, gatewayKey: extra.gatewayKey,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, pool, url };
}
```

3. In `describe("gateway over real sockets", ...)`, replace the `before` and `after` hooks with:

```ts
  let stubPresidio: StubPresidio;
  before(async () => {
    stubPresidio = await startStubPresidio();
    presidioUrl = stubPresidio.url;
    ups.push(await upstream("small-ok", "ok"), await upstream("large-ok", "ok"), await upstream("small-down", "fail500"), await upstream("slow", "slow"));
  });
  after(async () => {
    ups.forEach((u) => u.server.close());
    await stubPresidio.close();
  });
```

4. Delete the test `it("serves a tool-bearing request from the agentic chain, not the cheap tier", ...)`. It asserts the `x-chainaim-profile` header of the routing profiles, which spec D8 retires (spec section 11, item 10). It is the failing test listed under "Known issues" in `DEMO.md`.

- [ ] **Step 9: Run the whole gateway suite**

Run: `npm test`
Expected: PASS for every file (`gateway`, `presidio`, `privacy`, `scan-mask`), 0 failures, and the run exits by itself.

- [ ] **Step 10: Update the docs**

In `README.md`:
- Add these rows at the top of the Endpoints table:

```markdown
| POST | /v1/privacy/scan | gateway key if set | Entities (type, UTF-16 start/end, score), classes and data policy; no model is called |
| POST | /v1/privacy/mask | gateway key if set | Masked text, placeholder map, counts, cards removed |
```

- Change the `/healthz` row's purpose to `200 when Presidio answered its last check, else 503`.
- Add this section before "Routing strategies":

````markdown
## Privacy endpoints locally

The gateway needs a Presidio analyzer. Without Docker, the stub detects the synthetic corpus in
`scripts/synthetic-corpus.ts` (never real data):

```powershell
npm run stub-presidio                                   # terminal 1, port 5002
npm run gateway -- --catalog config/catalog.json        # terminal 2
Invoke-RestMethod http://127.0.0.1:8700/v1/privacy/mask -Method Post -ContentType application/json `
  -Body '{"text":"Patient Jane Roe, MRN 991122, was diagnosed with diabetes."}'
```

The gateway refuses to start until Presidio answers and supports every required entity.
````

In `DEMO.md`, under "Known issues (as of 2026-09-22)", delete the bullet that begins "Don't run `npm test` in a demo." (the failing test is gone).

- [ ] **Step 11: Commit**

```bash
git add services/gateway/src/errors.ts services/gateway/src/server.ts services/gateway/src/ledger.ts services/gateway/src/main.ts services/gateway/test/helpers.ts services/gateway/test/scan-mask.test.ts services/gateway/test/gateway.test.ts README.md DEMO.md
git commit -m "feat(gateway): scan and mask routes, Presidio health and privacy ledger lines" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Milestone A done when** `npm test` passes with 0 failures, and a manual run of `npm run stub-presidio` plus `npm run gateway` answers the mask example in `README.md` with `<PERSON_1>` and `<MEDICAL_RECORD_1>`.

---

## Part B: paywall and deployment

The paywall is a separate package with its own dependencies (spec D7). Its tests run with `npm --prefix services/paywall test` (root script `test:paywall`), not with the gateway suite. Installing its dependencies takes several minutes on this network.

### Task B1: Paywall package, configuration and paid routes

**Files:**
- Create: `services/paywall/package.json`
- Create: `services/paywall/package-lock.json` (written by `npm install`)
- Create: `services/paywall/src/config.ts`
- Create: `services/paywall/src/routes.ts`
- Test: `services/paywall/test/config.test.ts`
- Modify: `package.json` (root: add the `test:paywall` script)

**Interfaces:**
- Consumes: nothing from the gateway (the paywall talks to it over HTTP only).
- Produces:
  - `config.ts`: `NETWORKS = { testnet: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", mainnet: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" } as const`; `type NetworkName = keyof typeof NETWORKS`; `CHALLENGE_TAG = "x402-global-challenge"`; `DEFAULT_FACILITATOR = "https://facilitator.goplausible.xyz"`; `type PaywallConfig = { network: string; networkName: NetworkName; payTo: string; facilitatorUrl: string; gatewayUrl: string; gatewayKey: string; gatewayTimeoutMs: number; port: number; host: string; publicBaseUrl: string | undefined }`; `loadConfig(env: Record<string, string | undefined>): PaywallConfig` (throws an `Error` naming the bad variable).
  - `routes.ts`: `type PaidRoute = { key: string; path: string; price: string; description: string; discovery: Record<string, unknown> }`; `PAID_ROUTES: readonly PaidRoute[]` (scan, mask, chat in that order); `type RouteEntry`; `routesConfig(config: PaywallConfig): Record<string, RouteEntry>`, each entry `{ accepts: [{ scheme: "exact", price, network, payTo, extra: { tag } }], description, mimeType: "application/json", resource?, extensions }`.

- [ ] **Step 1: Create the package and install its dependencies**

Create `services/paywall/package.json`:

```json
{
  "name": "@chainaim/paywall",
  "version": "0.1.0",
  "private": true,
  "description": "chainaim-paywall: x402 payments (USDC on Algorand) in front of the private chainaim-gateway.",
  "type": "module",
  "engines": {
    "node": ">=22.22"
  },
  "scripts": {
    "start": "node src/main.ts",
    "test": "node --test --test-force-exit \"test/*.test.ts\""
  },
  "dependencies": {
    "@hono/node-server": "2.1.1",
    "@x402-avm/extensions": "2.6.1",
    "@x402/avm": "2.27.0",
    "@x402/core": "2.27.0",
    "@x402/hono": "2.27.0",
    "hono": "4.13.9"
  }
}
```

Run (it can take several minutes):

```bash
cd services/paywall && npm install --no-audit --no-fund
```

Expected: `added N packages`, a new `services/paywall/package-lock.json`, and `services/paywall/node_modules/`, which the root `.gitignore` rule `node_modules/` already ignores. Check with `git status --short` that no `node_modules` path is listed.

In the root `package.json`, add to `"scripts"` after `"test:engine"`:

```json
    "test:paywall": "npm --prefix services/paywall test",
```

- [ ] **Step 2: Write the failing test**

Create `services/paywall/test/config.test.ts`:

```ts
/**
 * Paywall configuration and the paid-route table (spec section 9).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHALLENGE_TAG, loadConfig, NETWORKS } from "../src/config.ts";
import { PAID_ROUTES, routesConfig } from "../src/routes.ts";

const PAY_TO = "IDNTKBLAMSMIBR5DV5GRRZC7PNDOGRUOSOLHZ7BIOVXJPOWT2O24BMVDPE";
const env = { AVM_PAY_TO: PAY_TO, GATEWAY_URL: "http://gateway.railway.internal:8700", CHAINAIM_GATEWAY_KEY: "test-key" };

describe("loadConfig", () => {
  it("defaults to TestNet, the GoPlausible facilitator and port 8080", () => {
    const c = loadConfig(env);
    assert.equal(c.network, "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");
    assert.equal(c.networkName, "testnet");
    assert.equal(c.facilitatorUrl, "https://facilitator.goplausible.xyz");
    assert.equal(c.port, 8080);
    assert.equal(c.host, "0.0.0.0");
    assert.equal(c.publicBaseUrl, undefined);
  });

  it("selects MainNet", () => {
    assert.equal(loadConfig({ ...env, X402_NETWORK: "mainnet" }).network, "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=");
  });

  it("names the variable that is missing or wrong", () => {
    assert.throws(() => loadConfig({ ...env, AVM_PAY_TO: "" }), /AVM_PAY_TO/);
    assert.throws(() => loadConfig({ ...env, AVM_PAY_TO: "not-an-algorand-address" }), /AVM_PAY_TO/);
    assert.throws(() => loadConfig({ ...env, GATEWAY_URL: "" }), /GATEWAY_URL/);
    assert.throws(() => loadConfig({ ...env, GATEWAY_URL: "gateway:8700" }), /GATEWAY_URL/);
    assert.throws(() => loadConfig({ ...env, CHAINAIM_GATEWAY_KEY: "" }), /CHAINAIM_GATEWAY_KEY/);
    assert.throws(() => loadConfig({ ...env, X402_NETWORK: "betanet" }), /X402_NETWORK/);
    assert.throws(() => loadConfig({ ...env, X402_NETWORK: "toString" }), /X402_NETWORK/);
    assert.throws(() => loadConfig({ ...env, PORT: "eighty" }), /PORT/);
  });

  it("needs PUBLIC_BASE_URL to be https and strips a trailing slash", () => {
    assert.equal(loadConfig({ ...env, PUBLIC_BASE_URL: "https://pay.example.com/" }).publicBaseUrl, "https://pay.example.com");
    assert.throws(() => loadConfig({ ...env, PUBLIC_BASE_URL: "http://pay.example.com" }), /PUBLIC_BASE_URL/);
  });
});

describe("paid routes", () => {
  it("prices scan, mask and chat as the spec says", () => {
    assert.deepEqual(
      PAID_ROUTES.map((r) => [r.key, r.price]),
      [["POST /v1/privacy/scan", "$0.002"], ["POST /v1/privacy/mask", "$0.003"], ["POST /v1/chat/completions", "$0.01"]],
    );
  });

  it("puts the scheme, network, payTo and challenge tag on every accepts entry", () => {
    const routes = routesConfig(loadConfig({ ...env, X402_NETWORK: "mainnet", PUBLIC_BASE_URL: "https://pay.example.com" }));
    for (const r of PAID_ROUTES) {
      const entry = routes[r.key];
      assert.deepEqual(entry.accepts, [{ scheme: "exact", price: r.price, network: NETWORKS.mainnet, payTo: PAY_TO, extra: { tag: CHALLENGE_TAG } }]);
      assert.equal(entry.resource, `https://pay.example.com${r.path}`);
      assert.equal(entry.mimeType, "application/json");
      assert.equal(entry.description, r.description);
    }
  });

  it("leaves the resource URL to the request when PUBLIC_BASE_URL is unset", () => {
    const routes = routesConfig(loadConfig(env));
    for (const r of PAID_ROUTES) assert.equal("resource" in routes[r.key], false);
  });

  it("declares Bazaar discovery metadata with an input example and an output example", () => {
    const routes = routesConfig(loadConfig(env));
    type Info = { input: { body: Record<string, unknown> }; output: { example: unknown } };
    const info = (key: string): Info => (routes[key].extensions as { bazaar: { info: Info } }).bazaar.info;
    assert.deepEqual(Object.keys(info("POST /v1/privacy/scan").input.body), ["text"]);
    assert.deepEqual(Object.keys(info("POST /v1/privacy/mask").input.body), ["text"]);
    assert.ok(Array.isArray(info("POST /v1/chat/completions").input.body.messages));
    for (const r of PAID_ROUTES) assert.ok(info(r.key).output.example, `${r.key} has an output example`);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd services/paywall && node --test test/config.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/config.ts`.

- [ ] **Step 4: Write the implementation**

Create `services/paywall/src/config.ts`:

```ts
/**
 * Paywall configuration from the environment (spec sections 9 and 10). The
 * gateway key is the only secret, and it is never logged.
 */
export const NETWORKS = {
  testnet: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  mainnet: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
} as const;
export type NetworkName = keyof typeof NETWORKS;

/** Required on every accepts entry for the Global x402 Challenge (V3). */
export const CHALLENGE_TAG = "x402-global-challenge";
export const DEFAULT_FACILITATOR = "https://facilitator.goplausible.xyz";

export type PaywallConfig = {
  network: string;
  networkName: NetworkName;
  /** The one Algorand account every route pays. */
  payTo: string;
  facilitatorUrl: string;
  /** The private gateway, e.g. http://gateway.railway.internal:8700 */
  gatewayUrl: string;
  gatewayKey: string;
  /** How long a proxied call may take; chat can try three models. */
  gatewayTimeoutMs: number;
  port: number;
  host: string;
  /** Public origin such as https://pay.example.com: the resource URL in 402s and the Bazaar. */
  publicBaseUrl: string | undefined;
};

export function loadConfig(env: Record<string, string | undefined>): PaywallConfig {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  const required = (name: string): string => {
    const v = value(name);
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const integer = (name: string, fallback: number): number => {
    const v = value(name);
    const n = v === undefined ? fallback : Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${v}`);
    return n;
  };

  const networkName = value("X402_NETWORK") ?? "testnet";
  if (!Object.hasOwn(NETWORKS, networkName)) throw new Error("X402_NETWORK must be testnet or mainnet");
  const payTo = required("AVM_PAY_TO");
  if (!/^[A-Z2-7]{58}$/.test(payTo)) throw new Error("AVM_PAY_TO must be a 58-character Algorand address");
  const gatewayUrl = required("GATEWAY_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(gatewayUrl) || !URL.canParse(gatewayUrl)) throw new Error("GATEWAY_URL must be an http(s) URL");
  const publicBaseUrl = value("PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  if (publicBaseUrl !== undefined && (!publicBaseUrl.startsWith("https://") || !URL.canParse(publicBaseUrl))) {
    throw new Error("PUBLIC_BASE_URL must be an https URL");
  }
  return {
    network: NETWORKS[networkName as NetworkName],
    networkName: networkName as NetworkName,
    payTo,
    facilitatorUrl: (value("FACILITATOR_URL") ?? DEFAULT_FACILITATOR).replace(/\/+$/, ""),
    gatewayUrl,
    gatewayKey: required("CHAINAIM_GATEWAY_KEY"),
    gatewayTimeoutMs: integer("GATEWAY_TIMEOUT_MS", 200_000),
    port: integer("PORT", 8080),
    host: value("HOST") ?? "0.0.0.0",
    publicBaseUrl,
  };
}
```

Create `services/paywall/src/routes.ts`:

```ts
/**
 * The three paid routes: price, description and Bazaar discovery metadata
 * (spec section 9). Every example here is synthetic.
 */
import { declareDiscoveryExtension } from "@x402-avm/extensions";
import { CHALLENGE_TAG, type PaywallConfig } from "./config.ts";

export type PaidRoute = { key: string; path: string; price: string; description: string; discovery: Record<string, unknown> };

const EXAMPLE_TEXT = "Patient Jane Roe, MRN 991122, was diagnosed with diabetes.";
const textSchema = (verb: string) => ({
  type: "object",
  properties: { text: { type: "string", minLength: 1, maxLength: 20000, description: `Text to ${verb}, 1 to 20,000 characters` } },
  required: ["text"],
});

export const PAID_ROUTES: readonly PaidRoute[] = [
  {
    key: "POST /v1/privacy/scan",
    path: "/v1/privacy/scan",
    price: "$0.002",
    description: "Finds personal, health and card data in text and returns entity types, positions and the data class. No model is called.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: { text: EXAMPLE_TEXT },
      inputSchema: textSchema("scan"),
      output: {
        example: {
          decisionId: "7d0c2a1e-5b7f-4c1e-9a53-2f6f0b8e41aa",
          dataClass: "PHI",
          found: ["PHI", "PII"],
          entities: [
            { type: "PERSON", start: 8, end: 16, score: 0.85 },
            { type: "MEDICAL_RECORD", start: 22, end: 28, score: 0.45 },
            { type: "HEALTH_TERM", start: 34, end: 43, score: 1 },
            { type: "HEALTH_TERM", start: 49, end: 57, score: 1 },
          ],
          counts: { PERSON: 1, MEDICAL_RECORD: 1, HEALTH_TERM: 2 },
          policy: { dataCollection: "deny", cardDataRemoved: false },
        },
      },
    }),
  },
  {
    key: "POST /v1/privacy/mask",
    path: "/v1/privacy/mask",
    price: "$0.003",
    description: "Replaces personal and health identifiers with numbered placeholders and removes card numbers. Returns the masked text and the map to restore it.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: { text: EXAMPLE_TEXT },
      inputSchema: textSchema("mask"),
      output: {
        example: {
          decisionId: "0b9e5f3c-2d41-4a8e-b6c7-91d2e8f4a310",
          dataClass: "PHI",
          found: ["PHI", "PII"],
          maskedText: "Patient <PERSON_1>, MRN <MEDICAL_RECORD_1>, was diagnosed with diabetes.",
          map: { "<PERSON_1>": "Jane Roe", "<MEDICAL_RECORD_1>": "991122" },
          counts: { PERSON: 1, MEDICAL_RECORD: 1, HEALTH_TERM: 2 },
          cardsRemoved: 0,
        },
      },
    }),
  },
  {
    key: "POST /v1/chat/completions",
    path: "/v1/chat/completions",
    price: "$0.01",
    description: "OpenAI-compatible private chat. Masks the conversation, routes it with Jev across free models under a data policy set by what it contains, and restores the answer.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        model: "chainaim/auto",
        messages: [{ role: "user", content: "Write a two-line reminder to Jane Roe (jane.roe@example.com) about Friday's 10:00 meeting." }],
        max_tokens: 200,
      },
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            minItems: 1,
            description: "OpenAI chat messages; text only, at most 48,000 characters in total",
            items: { type: "object", properties: { role: { type: "string" }, content: { description: "a string, or an array of text parts" } }, required: ["role"] },
          },
          model: { type: "string", description: "chainaim/auto, or a free model id from GET /v1/models" },
          max_tokens: { type: "integer", minimum: 1, maximum: 1024 },
          stream: { type: "boolean" },
          tools: { type: "array" },
          response_format: { type: "object" },
        },
        required: ["messages"],
      },
      output: {
        example: {
          id: "gen-1790000000-example",
          object: "chat.completion",
          model: "qwen/qwen3.8-27b:free",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hi Jane Roe, a reminder that we meet on Friday at 10:00. Reply to jane.roe@example.com if that time doesn't work." },
              finish_reason: "stop",
            },
          ],
        },
      },
    }),
  },
];

export type RouteEntry = {
  accepts: { scheme: "exact"; price: string; network: string; payTo: string; extra: { tag: string } }[];
  description: string;
  mimeType: "application/json";
  resource?: string;
  extensions: Record<string, unknown>;
};

/** The route table for paymentMiddleware: one exact USDC price per route, the challenge tag, and the Bazaar metadata. */
export function routesConfig(config: PaywallConfig): Record<string, RouteEntry> {
  return Object.fromEntries(
    PAID_ROUTES.map((r): [string, RouteEntry] => [
      r.key,
      {
        accepts: [{ scheme: "exact", price: r.price, network: config.network, payTo: config.payTo, extra: { tag: CHALLENGE_TAG } }],
        description: r.description,
        mimeType: "application/json",
        ...(config.publicBaseUrl ? { resource: `${config.publicBaseUrl}${r.path}` } : {}),
        extensions: r.discovery,
      },
    ]),
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/paywall && node --test test/config.test.ts`
Expected: PASS, 8 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add services/paywall/package.json services/paywall/package-lock.json services/paywall/src/config.ts services/paywall/src/routes.ts services/paywall/test/config.test.ts package.json
git commit -m "feat(paywall): configuration and the paid-route table with the challenge tag" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task B2: Paywall app: capacity guard, payment, proxy and payment log

**Files:**
- Create: `services/paywall/src/app.ts`
- Create: `services/paywall/src/main.ts`
- Create: `services/paywall/test/stubs.ts` (stub facilitator, stub gateway, paywall starter; Task B4 reuses them)
- Test: `services/paywall/test/paywall.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `PaywallConfig`, `NETWORKS`, `CHALLENGE_TAG` (B1); `PAID_ROUTES`, `routesConfig` (B1). The gateway's HTTP contract: `GET /internal/capacity` answers `{ chatAvailable: boolean, reason?: string, retryAfterSec?: number }`. Task C9 adds that route; until then the gateway answers 404, and the guard refuses chat (fail closed).
- Produces:
  - `app.ts`: `MAX_BODY_BYTES = 4 * 1024 * 1024`; `type PaywallDeps = { log?: (line: string) => void }`; `createPaywall(config: PaywallConfig, deps?: PaywallDeps): Hono`.
  - `test/stubs.ts`: `PAY_TO` (synthetic address); `listen(server: Server): Promise<string>`; `close(server: Server): Promise<void>`; `stubFacilitator(): { server: Server; calls: string[] }`; `type Seen`; `stubGateway(): { server: Server; seen: Seen[]; state: { status: number; capacityStatus: number; capacity: Record<string, unknown> } }`; `startPaywall(env: Record<string, string>, log?: (line: string) => void): Promise<{ url: string; close(): Promise<void> }>`.

- [ ] **Step 1: Write the test stubs**

Create `services/paywall/test/stubs.ts`:

```ts
/**
 * Test doubles for the paywall: a facilitator that accepts every payment and
 * records which endpoints were called, and a gateway that records what
 * reaches it. No real payment and no network call leave the machine.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createPaywall } from "../src/app.ts";
import { loadConfig, NETWORKS } from "../src/config.ts";

/** Synthetic Algorand address used as payTo and fee payer. */
export const PAY_TO = "IDNTKBLAMSMIBR5DV5GRRZC7PNDOGRUOSOLHZ7BIOVXJPOWT2O24BMVDPE";

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function close(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** Supports both networks, says every payment is valid, and settles with a fake transaction id. */
export function stubFacilitator(): { server: Server; calls: string[] } {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    await readBody(req);
    calls.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/supported") {
      const kinds = Object.values(NETWORKS).map((network) => ({ x402Version: 2, scheme: "exact", network, extra: { feePayer: PAY_TO } }));
      res.end(JSON.stringify({ kinds, extensions: ["bazaar"], signers: {} }));
    } else if (req.url === "/verify") {
      res.end(JSON.stringify({ isValid: true, payer: "BUYERADDRESS" }));
    } else if (req.url === "/settle") {
      res.end(JSON.stringify({ success: true, transaction: "TX-STUB-1", network: NETWORKS.testnet, payer: "BUYERADDRESS" }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  return { server, calls };
}

export type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: string };

/** Records every request. Paid paths answer with state.status; /internal/capacity with state.capacity. */
export function stubGateway(): { server: Server; seen: Seen[]; state: { status: number; capacityStatus: number; capacity: Record<string, unknown> } } {
  const seen: Seen[] = [];
  const state = { status: 200, capacityStatus: 200, capacity: { chatAvailable: true } as Record<string, unknown> };
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = new URL(req.url ?? "/", "http://gateway.local").pathname;
    seen.push({ method: req.method ?? "", path, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (path === "/internal/capacity") {
      res.statusCode = state.capacityStatus;
      res.end(JSON.stringify(state.capacity));
      return;
    }
    if (path === "/healthz" || path === "/v1/models") {
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.statusCode = state.status;
    res.setHeader("x-chainaim-decision-id", "decision-1");
    res.setHeader("x-internal-note", "must not reach the caller");
    res.end(JSON.stringify(state.status < 400 ? { ok: true } : { error: { message: "refused", code: state.status } }));
  });
  return { server, seen, state };
}

/** A paywall on a loopback port. */
export async function startPaywall(env: Record<string, string>, log?: (line: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createPaywall(loadConfig(env), { log: log ?? (() => {}) });
  let server: Server | undefined;
  const url = await new Promise<string>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(`http://127.0.0.1:${info.port}`)) as Server;
  });
  return { url, close: () => close(server!) };
}
```

- [ ] **Step 2: Write the failing test**

Create `services/paywall/test/paywall.test.ts`:

```ts
/**
 * The paywall over real sockets, against the stub facilitator and the stub
 * gateway (spec section 11, item 9).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { CHALLENGE_TAG, NETWORKS } from "../src/config.ts";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const KEY = "test-gateway-key";

type PaymentRequired = { accepts: Record<string, any>[]; resource: { url: string }; extensions?: Record<string, any>; [key: string]: any };
const decode = (header: string | null): PaymentRequired => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
/** A payment payload the stub facilitator accepts: it echoes the first accepted requirement. */
const paymentFor = (required: PaymentRequired): string =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: required.accepts[0], payload: { paymentGroup: ["AAAA"], paymentIndex: 0 }, resource: required.resource })).toString("base64");

describe("paywall (TestNet)", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  const logs: string[] = [];
  let paywall: { url: string; close: () => Promise<void> };

  before(async () => {
    const facilitatorUrl = await listen(facilitator.server);
    const gatewayUrl = await listen(gateway.server);
    paywall = await startPaywall(
      { AVM_PAY_TO: PAY_TO, GATEWAY_URL: gatewayUrl, CHAINAIM_GATEWAY_KEY: KEY, FACILITATOR_URL: facilitatorUrl, PUBLIC_BASE_URL: "https://pay.example.com" },
      (line) => logs.push(line),
    );
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });
  beforeEach(() => {
    gateway.seen.length = 0;
    facilitator.calls.length = 0;
    gateway.state.status = 200;
    gateway.state.capacityStatus = 200;
    gateway.state.capacity = { chatAvailable: true };
    logs.length = 0;
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${paywall.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const priceOf = async (path: string): Promise<PaymentRequired> => decode((await post(path, { text: "Jane Roe" })).headers.get("payment-required"));

  it("asks for payment with the price, network, payTo, tag and Bazaar metadata", async () => {
    for (const [path, amount] of [["/v1/privacy/scan", "2000"], ["/v1/privacy/mask", "3000"], ["/v1/chat/completions", "10000"]]) {
      const r = await post(path, { text: "Jane Roe" });
      assert.equal(r.status, 402, path);
      const required = decode(r.headers.get("payment-required"));
      const a = required.accepts[0];
      assert.deepEqual([a.scheme, a.network, a.amount, a.asset, a.payTo, a.extra.tag], ["exact", NETWORKS.testnet, amount, "10458941", PAY_TO, CHALLENGE_TAG]);
      assert.equal(required.resource.url, `https://pay.example.com${path}`);
      assert.ok(required.extensions?.bazaar?.info?.input, `${path} carries Bazaar input metadata`);
    }
    assert.deepEqual(gateway.seen.map((s) => s.path), ["/internal/capacity"], "only the capacity guard reached the gateway");
  });

  it("never settles a paid call that the gateway refuses", async () => {
    gateway.state.status = 503;
    const required = await priceOf("/v1/privacy/scan");
    facilitator.calls.length = 0;
    const r = await post("/v1/privacy/scan", { text: "Jane Roe" }, { "payment-signature": paymentFor(required) });
    assert.equal(r.status, 503);
    assert.deepEqual(facilitator.calls, ["/verify"]);
    assert.equal(r.headers.get("payment-response"), null);
    assert.deepEqual(logs, [], "no payment logged");
  });

  it("settles a served call, returns the receipt and logs the payment without any body", async () => {
    const required = await priceOf("/v1/privacy/mask");
    facilitator.calls.length = 0;
    const r = await post("/v1/privacy/mask", { text: "Jane Roe" }, { "payment-signature": paymentFor(required) });
    assert.equal(r.status, 200);
    assert.deepEqual(facilitator.calls, ["/verify", "/settle"]);
    assert.equal(decode(r.headers.get("payment-response")).transaction, "TX-STUB-1");
    assert.equal(logs.length, 1);
    const line = JSON.parse(logs[0]);
    assert.deepEqual(
      [line.event, line.route, line.amount, line.asset, line.payer, line.transaction],
      ["payment_settled", "POST /v1/privacy/mask", "3000", "10458941", "BUYERADDRESS", "TX-STUB-1"],
    );
    assert.ok(!logs[0].includes("Jane"), "no request text in the payment log");
    assert.equal("decisionId" in line, false, "no decision id in the payment log");
  });

  it("forwards the body with the gateway key and never the payment headers", async () => {
    const required = await priceOf("/v1/privacy/scan");
    gateway.seen.length = 0;
    await post("/v1/privacy/scan", { text: "Jane Roe" }, { "payment-signature": paymentFor(required), "x-payment": "legacy", cookie: "a=b" });
    const s = gateway.seen.find((x) => x.path === "/v1/privacy/scan");
    assert.ok(s, "the paid call reached the gateway");
    assert.equal(s.headers.authorization, `Bearer ${KEY}`);
    for (const h of ["payment-signature", "x-payment", "cookie"]) assert.equal(s.headers[h], undefined, h);
    assert.deepEqual(JSON.parse(s.body), { text: "Jane Roe" });
  });

  it("passes back only content-type, retry-after and x-chainaim headers", async () => {
    const required = await priceOf("/v1/privacy/scan");
    const r = await post("/v1/privacy/scan", { text: "Jane Roe" }, { "payment-signature": paymentFor(required) });
    assert.equal(r.headers.get("x-chainaim-decision-id"), "decision-1");
    assert.equal(r.headers.get("x-internal-note"), null);
  });

  it("the capacity guard answers 503 with Retry-After and no price when chat cannot be served", async () => {
    gateway.state.capacity = { chatAvailable: false, reason: "rate_limited", retryAfterSec: 17 };
    const r = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "17");
    assert.equal(r.headers.get("payment-required"), null);
    assert.match((await r.json()).error.message, /not charged/);
  });

  it("the capacity guard refuses chat when the gateway cannot say (fail closed)", async () => {
    gateway.state.capacityStatus = 404;
    const r = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "60");
    assert.equal(r.headers.get("payment-required"), null);
  });

  it("serves /healthz and /v1/models without payment, with the gateway key", async () => {
    assert.equal((await fetch(`${paywall.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${paywall.url}/v1/models`)).status, 200);
    assert.equal(gateway.seen.length, 2);
    assert.ok(gateway.seen.every((s) => s.headers.authorization === `Bearer ${KEY}`));
    assert.equal(facilitator.calls.length, 0);
  });

  it("rejects bodies over 4 MiB with 413 before any payment step", async () => {
    const r = await post("/v1/privacy/scan", { text: "x".repeat(4_200_000) });
    assert.equal(r.status, 413);
    assert.equal(r.headers.get("payment-required"), null);
  });

  it("answers unknown routes with 404 and no price", async () => {
    const r = await fetch(`${paywall.url}/v1/other`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("payment-required"), null);
  });
});

describe("paywall (MainNet)", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  let paywall: { url: string; close: () => Promise<void> };
  before(async () => {
    paywall = await startPaywall({
      AVM_PAY_TO: PAY_TO,
      GATEWAY_URL: await listen(gateway.server),
      CHAINAIM_GATEWAY_KEY: KEY,
      FACILITATOR_URL: await listen(facilitator.server),
      X402_NETWORK: "mainnet",
    });
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });

  it("prices in MainNet USDC (ASA 31566704)", async () => {
    const r = await fetch(`${paywall.url}/v1/privacy/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"text":"hi"}' });
    const a = decode(r.headers.get("payment-required")).accepts[0];
    assert.deepEqual([a.network, a.asset, a.amount], [NETWORKS.mainnet, "31566704", "2000"]);
  });
});

describe("main", () => {
  it("exits with a clear message when the configuration is missing", () => {
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const env = { ...process.env, AVM_PAY_TO: "", GATEWAY_URL: "", CHAINAIM_GATEWAY_KEY: "" };
    const r = spawnSync(process.execPath, ["src/main.ts"], { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AVM_PAY_TO is required/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd services/paywall && node --test test/paywall.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/app.ts` (imported by `stubs.ts`).

- [ ] **Step 4: Write the app and the entry point**

Create `services/paywall/src/app.ts`:

```ts
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
import { PAID_ROUTES, routesConfig } from "./routes.ts";

/** The same limit as the gateway's default --max-body-bytes. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Gateway response headers passed back to the caller; everything else is dropped. */
const PASS_BACK = /^(content-type|retry-after|x-chainaim-[a-z-]+)$/;

export type PaywallDeps = { log?: (line: string) => void };

function errorBody(c: Context, status: 404 | 413 | 502 | 503, message: string, headers: Record<string, string> = {}): Response {
  return c.json({ error: { message, type: status >= 500 ? "gateway_error" : "invalid_request_error", code: status } }, status, headers);
}

export function createPaywall(config: PaywallConfig, deps: PaywallDeps = {}): Hono {
  const log = deps.log ?? ((line: string) => console.log(line));
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl })).register(config.network, new ExactAvmScheme());
  server.registerExtension(bazaarResourceServerExtension as never);
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

  /** Forward the method, path, content type and body; pass back the status, body and allowed headers. */
  async function proxy(c: Context): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.gatewayKey}` };
    const type = c.req.header("content-type");
    if (type) headers["content-type"] = type;
    const init: RequestInit = { method: c.req.method, headers, signal: AbortSignal.timeout(config.gatewayTimeoutMs) };
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
  app.get("/v1/models", proxy);
  app.get("/healthz", proxy);
  app.notFound((c) => errorBody(c, 404, `no route for ${c.req.method} ${c.req.path}`));
  return app;
}
```

Create `services/paywall/src/main.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:paywall`
Expected: PASS for `config.test.ts` and `paywall.test.ts`, 0 failures, and the run exits by itself. If a test fails, read the middleware in `services/paywall/node_modules/@x402/hono/dist/esm/index.mjs` before changing anything. The tests encode the spec, so fix the code, not the assertions.

- [ ] **Step 6: Commit**

```bash
git add services/paywall/src/app.ts services/paywall/src/main.ts services/paywall/test/stubs.ts services/paywall/test/paywall.test.ts
git commit -m "feat(paywall): x402 payment, capacity guard, header-stripping proxy and payment log" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task B3: Images, Railway config, the Presidio check and the deployment runbook

**Files:**
- Create: `services/presidio/Dockerfile`, `services/presidio/enable_recognizers.py`, `services/presidio/railway.json`
- Create: `services/gateway/Dockerfile`, `services/gateway/railway.json`, `.dockerignore`
- Create: `services/paywall/Dockerfile`, `services/paywall/.dockerignore`, `services/paywall/railway.json`
- Create: `scripts/verify-presidio.ts`
- Modify: `services/gateway/test/presidio.test.ts` (append a suite)
- Create: `docs/deploy/railway.md`
- Modify: `.env.example`, `package.json` (root: `verify:presidio` script)

**Interfaces:**
- Consumes: `PresidioClient`, `REQUIRED_PRESIDIO_ENTITIES`, `classify`, `CORPUS`, `KNOWN_VALUES`, `startStubPresidio` (Part A). The paywall's environment variables (B1).
- Produces: `scripts/verify-presidio.ts`: `verifyPresidio(url: string): Promise<{ ok: boolean; lines: string[] }>` (lines hold item ids, classes and entity types, never text). Three images: presidio (port 3000 on `[::]`), gateway (port 8700 on `::`), paywall (`PORT`).

- [ ] **Step 1: Write the failing test for the Presidio check**

In `services/gateway/test/presidio.test.ts`, add these imports below the existing ones:

```ts
import { CORPUS, KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { verifyPresidio } from "../../../scripts/verify-presidio.ts";
```

Append at the end of the file:

```ts
describe("scripts/verify-presidio.ts", () => {
  let stub: StubPresidio;
  before(async () => {
    stub = await startStubPresidio();
  });
  after(() => stub.close());

  it("passes against a Presidio that supports every entity and classifies the corpus", async () => {
    const { ok, lines } = await verifyPresidio(stub.url);
    assert.equal(ok, true, lines.join("\n"));
    assert.equal(lines.length, CORPUS.length + 1);
  });

  it("fails when a required entity is missing, and never prints corpus text", async () => {
    stub.mode = "missing-entities";
    try {
      const { ok, lines } = await verifyPresidio(stub.url);
      assert.equal(ok, false);
      assert.match(lines[0], /IN_AADHAAR/);
      const printed = lines.join("\n");
      for (const { value } of KNOWN_VALUES) assert.ok(!printed.includes(value), `${value} printed`);
    } finally {
      stub.mode = "ok";
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/presidio.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../../../scripts/verify-presidio.ts`.

- [ ] **Step 3: Write the check**

Create `scripts/verify-presidio.ts`:

```ts
/**
 * V4 check against a running Presidio analyzer: every required entity is
 * supported, and the synthetic corpus gets its expected data class with
 * ChainAim's ad-hoc recognizers. It prints item ids, classes and entity
 * types, never the text.
 *
 *   node scripts/verify-presidio.ts [--url http://127.0.0.1:5002]
 *
 * Exit code 0 = everything as expected.
 */
import { parseArgs } from "node:util";
import { classify } from "../services/gateway/src/privacy/classify.ts";
import { REQUIRED_PRESIDIO_ENTITIES } from "../services/gateway/src/privacy/entities.ts";
import { PresidioClient } from "../services/gateway/src/privacy/presidio.ts";
import { CORPUS } from "./synthetic-corpus.ts";

export async function verifyPresidio(url: string): Promise<{ ok: boolean; lines: string[] }> {
  const client = new PresidioClient({ url, threshold: 0.4, timeoutMs: 30_000 });
  const supported = new Set(await client.supportedEntities());
  const missing = REQUIRED_PRESIDIO_ENTITIES.filter((e) => !supported.has(e));
  let ok = missing.length === 0;
  const lines = [missing.length > 0 ? `FAIL missing entities: ${missing.join(", ")}` : `ok   all ${REQUIRED_PRESIDIO_ENTITIES.length} required entities are supported`];
  for (const item of CORPUS) {
    const found = await client.analyze(item.text);
    const { dataClass } = classify(found.map((e) => e.type));
    const pass = dataClass === item.expect.dataClass;
    ok &&= pass;
    const types = [...new Set(found.map((e) => e.type))].join(",") || "-";
    lines.push(`${pass ? "ok  " : "FAIL"} ${item.id.padEnd(12)} dataClass=${dataClass} (want ${item.expect.dataClass}) types=${types}`);
  }
  return { ok, lines };
}

if (import.meta.main ?? process.argv[1]?.endsWith("verify-presidio.ts")) {
  const { values } = parseArgs({ options: { url: { type: "string", default: "http://127.0.0.1:5002" } } });
  const { ok, lines } = await verifyPresidio(values.url!);
  for (const line of lines) console.log(line);
  process.exitCode = ok ? 0 : 1;
}
```

In the root `package.json`, add to `"scripts"` after `"stub-presidio"`:

```json
    "verify:presidio": "node scripts/verify-presidio.ts",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test services/gateway/test/presidio.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 5: Write the Presidio image and test its config script with local Python**

Create `services/presidio/enable_recognizers.py`:

```python
"""Copy Presidio's recognizer registry config, enabling the named predefined recognizers.

Usage: enable_recognizers.py SOURCE.yaml DEST.yaml RecognizerName [RecognizerName ...]
Exits non-zero (failing the image build) if a named recognizer is not in SOURCE.
"""
import sys

import yaml


def main() -> None:
    source, dest, *names = sys.argv[1:]
    with open(source, encoding="utf-8") as f:
        conf = yaml.safe_load(f)
    found = set()
    for recognizer in conf.get("recognizers", []):
        if isinstance(recognizer, dict) and recognizer.get("name") in names:
            recognizer["enabled"] = True
            found.add(recognizer["name"])
    missing = sorted(set(names) - found)
    if missing:
        sys.exit(f"recognizers not found in {source}: {', '.join(missing)}")
    with open(dest, "w", encoding="utf-8") as f:
        yaml.safe_dump(conf, f, sort_keys=False)
    print(f"enabled {', '.join(sorted(found))} in {dest}")


if __name__ == "__main__":
    main()
```

Create `services/presidio/Dockerfile`:

```dockerfile
# Presidio analyzer with the recognizers ChainAim needs (spec V4). The stock
# configuration ships InAadhaarRecognizer and InPanRecognizer disabled; this
# image enables them. It also binds [::] so Railway's private network (IPv6)
# can reach it. Build context: services/presidio.
FROM mcr.microsoft.com/presidio-analyzer:2.2.362
USER root
COPY enable_recognizers.py /tmp/enable_recognizers.py
RUN python /tmp/enable_recognizers.py \
      /app/presidio_analyzer/conf/default_recognizers.yaml \
      /app/chainaim_recognizers.yaml \
      InAadhaarRecognizer InPanRecognizer \
 && chown 1001 /app/chainaim_recognizers.yaml \
 && rm /tmp/enable_recognizers.py
USER 1001
ENV RECOGNIZER_REGISTRY_CONF_FILE=/app/chainaim_recognizers.yaml
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "exec gunicorn -w \"$WORKERS\" -b \"[::]:$PORT\" \"app:create_app()\""]
```

Create `services/presidio/railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": { "restartPolicyType": "ALWAYS" }
}
```

Test the script against Presidio's published default config (Python 3 with PyYAML is installed on this machine):

```bash
TMP=$(mktemp -d)
curl -sfL https://raw.githubusercontent.com/microsoft/presidio/main/presidio-analyzer/presidio_analyzer/conf/default_recognizers.yaml -o "$TMP/src.yaml"
python services/presidio/enable_recognizers.py "$TMP/src.yaml" "$TMP/out.yaml" InAadhaarRecognizer InPanRecognizer
python -c "import yaml,sys; c=yaml.safe_load(open(sys.argv[1])); r={x['name']:x.get('enabled',True) for x in c['recognizers']}; print(r['InAadhaarRecognizer'], r['InPanRecognizer'], r['UsNpiRecognizer'])" "$TMP/out.yaml"
python services/presidio/enable_recognizers.py "$TMP/src.yaml" "$TMP/bad.yaml" NoSuchRecognizer; echo "exit=$?"
```

Expected: `enabled InAadhaarRecognizer, InPanRecognizer in .../out.yaml`, then `True True False` (only the two named recognizers change), then `recognizers not found in ...: NoSuchRecognizer` and `exit=1`.

- [ ] **Step 6: Write the gateway and paywall images and their Railway config**

Create `services/gateway/Dockerfile`:

```dockerfile
# chainaim-gateway. Node runs the TypeScript directly: no build step and no
# npm dependencies. Build context: the repository root.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY packages/route-engine/package.json packages/route-engine/package.json
COPY packages/route-engine/dist packages/route-engine/dist
COPY config config
COPY services/gateway/src services/gateway/src
EXPOSE 8700
# The ledger goes to the volume mounted at /data. The process runs as root so
# it can write to Railway's root-owned volume.
ENTRYPOINT ["node", "services/gateway/src/main.ts"]
CMD ["--host", "::", "--port", "8700", "--api-key-env", "CHAINAIM_GATEWAY_KEY", "--catalog", "config/catalog.json", "--health-interval-ms", "0", "--presidio-url", "http://presidio.railway.internal:3000", "--ledger", "/data/ledger"]
```

Create `services/gateway/railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "services/gateway/Dockerfile" },
  "deploy": { "restartPolicyType": "ALWAYS" }
}
```

Create `.dockerignore` at the repository root:

```
.git
**/node_modules
.superpowers
data
models
secrets
.env
.env.*
eval
docs
```

Create `services/paywall/Dockerfile`:

```dockerfile
# chainaim-paywall. Build context: services/paywall.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
```

Create `services/paywall/.dockerignore`:

```
node_modules
test
scripts
```

Create `services/paywall/railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": { "restartPolicyType": "ALWAYS" }
}
```

- [ ] **Step 7: Build the images if Docker is running**

Run: `docker info --format '{{.ServerVersion}}'`

If it prints a version, build all three and run the Presidio check end to end:

```bash
docker build -t chainaim-presidio services/presidio
docker build -t chainaim-gateway -f services/gateway/Dockerfile .
docker build -t chainaim-paywall services/paywall
docker run -d --rm --name chainaim-presidio -p 5002:3000 chainaim-presidio
# wait until it answers (the spaCy model takes 20 to 60 s to load)
until curl -sf http://127.0.0.1:5002/health >/dev/null; do sleep 5; done
npm run verify:presidio -- --url http://127.0.0.1:5002
docker stop chainaim-presidio
```

Expected: three successful builds; the check prints `ok   all 13 required entities are supported`. Put the per-item lines in the report: they show how real detection compares with the stub (the stub's corpus lines all pass by construction). A real `FAIL` line is not a build failure; report it.

If Docker is not running, write "Docker daemon not available; images not built locally" in the report, and continue. The owner builds on Railway.

- [ ] **Step 8: Write the runbook and the environment example**

Create `docs/deploy/railway.md`:

````markdown
# Deploying on Railway

Three services in one Railway project, on its private network. Only the paywall is public. Fly.io works the same way (spec section 10).

| Service (exact name) | Root directory | Config file | Public | Variables |
|---|---|---|---|---|
| `presidio` | `services/presidio` | `services/presidio/railway.json` | no | `PORT=3000` |
| `gateway` | `/` | `services/gateway/railway.json` | no | `CHAINAIM_GATEWAY_KEY` (secret); `OPENROUTER_API_KEY` (secret, needed when chat launches) |
| `paywall` | `services/paywall` | `services/paywall/railway.json` | yes | `AVM_PAY_TO`, `X402_NETWORK`, `FACILITATOR_URL`, `GATEWAY_URL`, `PUBLIC_BASE_URL`, `CHAINAIM_GATEWAY_KEY` |

The service names matter: the gateway reaches `presidio.railway.internal:3000`, and the paywall reaches `gateway.railway.internal:8700`.

## 1. Before you start

- The repository is on GitHub (Railway builds from it, and the challenge asks for the link).
- A payTo account: an Algorand address you control. For MainNet it must be opted in to USDC (ASA 31566704).
- A separate buyer account for test payments (self-payments don't count for the challenge). On TestNet, fund it with ALGO and USDC from the TestNet dispensers.
- A gateway key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## 2. Create the services

1. New project, then "Deploy from GitHub repo", then this repository and branch.
2. `presidio`: Settings, Source, Root Directory `services/presidio`; Config-as-code path `services/presidio/railway.json`; variable `PORT=3000`; memory 2 GB. No public domain.
3. `gateway`: Root Directory `/`; config path `services/gateway/railway.json`; add a Volume mounted at `/data` (the decision ledger); variable `CHAINAIM_GATEWAY_KEY` = your key. No public domain.
4. `paywall`: Root Directory `services/paywall`; config path `services/paywall/railway.json`; Networking, Generate Domain. Variables:
   - `AVM_PAY_TO` = your payTo address
   - `X402_NETWORK` = `testnet` (switch to `mainnet` in step 5)
   - `FACILITATOR_URL` = `https://facilitator.goplausible.xyz`
   - `GATEWAY_URL` = `http://gateway.railway.internal:8700`
   - `PUBLIC_BASE_URL` = `https://<the generated domain>`
   - `CHAINAIM_GATEWAY_KEY` = `${{gateway.CHAINAIM_GATEWAY_KEY}}` (a reference to the gateway's value)

Every service uses the restart policy "always" (set in its `railway.json`). Expect about $10 to $25 a month, mostly Presidio's memory.

## 3. Check it

```bash
curl https://<domain>/healthz                     # {"status":"ok"} once Presidio is up
curl -si -X POST https://<domain>/v1/privacy/scan -H "content-type: application/json" -d '{"text":"hi"}' | grep -i payment-required
cd services/paywall && npm install && node scripts/pay.ts --dry-run https://<domain>/v1/privacy/scan '{"text":"hi"}'
```

The dry run prints the price (0.002 USDC), the asset, the network, your payTo and `tag=x402-global-challenge`. If the gateway can't start, its log names the missing Presidio entity or the unreachable Presidio.

## 4. Pay on TestNet

```bash
cd services/paywall
AVM_MNEMONIC="<buyer's 25 words>" node scripts/pay.ts https://<domain>/v1/privacy/scan '{"text":"Patient Jane Roe, MRN 991122, was diagnosed with diabetes."}'
```

Expect `HTTP 200`, the scan result and a payment line with a transaction id. The paywall's log shows one `payment_settled` line.

## 5. Switch to MainNet

1. Set `X402_NETWORK=mainnet` and `AVM_PAY_TO` to the MainNet payTo account (opted in to USDC). The service redeploys.
2. Make one real payment per live route from the separate buyer account: scan and mask now, chat when it launches. The challenge tag is written at settlement, so it is already on the first payment.
3. Check the Bazaar: `curl 'https://facilitator.goplausible.xyz/discovery/resources?limit=100'` and look for your domain.

## 6. Monitor

Create a free UptimeRobot HTTP monitor on `https://<domain>/healthz` every 5 minutes with email alerts. The paywall proxies it to the gateway, which checks Presidio, so one monitor covers all three services.

## 7. When chat launches

Add `OPENROUTER_API_KEY` to the gateway, buy $10 of OpenRouter credits (1,000 free-model requests a day), and redeploy the gateway. From Task C10 on its image runs with `--model-source openrouter-free`.
````

Replace `.env.example` with:

```
# Variable NAMES only. Real values live in your OS keychain or secrets manager
# (on Railway: service variables) and reach each service as environment variables.

# Bearer key shared by the gateway (--api-key-env CHAINAIM_GATEWAY_KEY) and the paywall
CHAINAIM_GATEWAY_KEY=

# Gateway: OpenRouter key for the free chat models and Jev (--model-source openrouter-free)
OPENROUTER_API_KEY=

# Paywall (services/paywall)
AVM_PAY_TO=
X402_NETWORK=testnet
FACILITATOR_URL=https://facilitator.goplausible.xyz
GATEWAY_URL=http://127.0.0.1:8700
PUBLIC_BASE_URL=

# Per-deployment upstream keys, referenced by "apiKeyEnv" in config/catalog.json
# CHAINAIM_OPENAI_KEY=
# CHAINAIM_ANTHROPIC_KEY=
# CHAINAIM_GPU_CLOUD_KEY=
```

- [ ] **Step 9: Run both suites and commit**

Run: `npm test` and `npm run test:paywall`
Expected: both PASS with 0 failures.

```bash
git add services/presidio services/gateway/Dockerfile services/gateway/railway.json .dockerignore services/paywall/Dockerfile services/paywall/.dockerignore services/paywall/railway.json scripts/verify-presidio.ts services/gateway/test/presidio.test.ts docs/deploy/railway.md .env.example package.json
git commit -m "build: Presidio, gateway and paywall images, Railway config and deployment runbook" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task B4: Payment client for the TestNet and MainNet checks

**Files:**
- Create: `services/paywall/scripts/pay.ts`
- Modify: `services/paywall/package.json` (devDependencies and a `pay` script), `services/paywall/package-lock.json`
- Test: `services/paywall/test/pay.test.ts`

**Interfaces:**
- Consumes: `startPaywall`, `stubFacilitator`, `stubGateway`, `listen`, `close`, `PAY_TO` (B2 `test/stubs.ts`).
- Produces: `node scripts/pay.ts [--dry-run] URL [JSON_BODY]` (run from `services/paywall`). `--dry-run` prints the price and pays nothing. Without it, it pays with the account in `AVM_MNEMONIC`. Exit codes: 0 success, 1 HTTP failure, 2 usage or missing mnemonic.

**Safety:** the paying path moves real funds on MainNet. The implementer runs only `--dry-run` and the usage checks. The owner runs real payments (docs/deploy/railway.md steps 4 and 5).

- [ ] **Step 1: Add the client dependencies**

Run (from `services/paywall`; it can take several minutes):

```bash
npm install --save-dev --save-exact --no-audit --no-fund @x402/fetch@2.27.0 @algorandfoundation/algokit-utils@10.0.0-alpha.42
```

Then add to `"scripts"` in `services/paywall/package.json`:

```json
    "pay": "node scripts/pay.ts",
```

Check that the imports resolve (run from `services/paywall`):

```bash
node --input-type=module -e "await Promise.all([import('@x402/fetch'), import('@x402/avm/exact/client'), import('@algorandfoundation/algokit-utils/algo25'), import('@algorandfoundation/algokit-utils/crypto')]); console.log('imports ok')"
```

Expected: `imports ok`.

- [ ] **Step 2: Write the failing test**

Create `services/paywall/test/pay.test.ts`:

```ts
/**
 * scripts/pay.ts against a local paywall with the stub facilitator: --dry-run
 * reads the price and pays nothing. The paying path needs a funded buyer
 * account; the owner runs it (docs/deploy/railway.md).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));

/** Async on purpose: the paywall runs in this process and must keep answering. */
function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/pay.ts", ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("scripts/pay.ts", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  let paywall: { url: string; close: () => Promise<void> };
  before(async () => {
    paywall = await startPaywall({
      AVM_PAY_TO: PAY_TO,
      GATEWAY_URL: await listen(gateway.server),
      CHAINAIM_GATEWAY_KEY: "test-key",
      FACILITATOR_URL: await listen(facilitator.server),
    });
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });

  it("--dry-run shows the price, network, payTo and tag, and pays nothing", async () => {
    const r = await run(["--dry-run", `${paywall.url}/v1/privacy/scan`, JSON.stringify({ text: "hi" })]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("price 0.002 USDC (asset 10458941)"), r.stdout);
    assert.ok(r.stdout.includes(`to ${PAY_TO}; tag=x402-global-challenge`), r.stdout);
    assert.ok(r.stdout.includes("bazaar=yes"), r.stdout);
    assert.ok(!facilitator.calls.includes("/verify") && !facilitator.calls.includes("/settle"), "nothing was verified or settled");
  });

  it("needs a URL", async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("usage"), r.stderr);
  });

  it("refuses to pay without AVM_MNEMONIC", async () => {
    const r = await run([`${paywall.url}/v1/privacy/scan`, JSON.stringify({ text: "hi" })], { AVM_MNEMONIC: "" });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("AVM_MNEMONIC"), r.stderr);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd services/paywall && node --test test/pay.test.ts`
Expected: FAIL: the child exits with code 1 and a module-not-found error for `scripts/pay.ts`.

- [ ] **Step 4: Write the client**

Create `services/paywall/scripts/pay.ts`:

```ts
/**
 * Pay for one call to a deployed paywall route: x402, exact scheme, USDC on
 * Algorand. The buyer is the account whose 25-word mnemonic is in
 * AVM_MNEMONIC; use an account other than payTo (self-payments do not count
 * for the challenge). --dry-run shows the price and pays nothing.
 *
 *   node scripts/pay.ts --dry-run https://PAYWALL/v1/privacy/scan '{"text":"..."}'
 *   AVM_MNEMONIC="word1 ... word25" node scripts/pay.ts https://PAYWALL/v1/privacy/scan '{"text":"..."}'
 */
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });
const [url, body = "{}"] = positionals;
if (!url) {
  console.error("usage: node scripts/pay.ts [--dry-run] URL [JSON_BODY]");
  process.exit(2);
}
JSON.parse(body); // fail early on a malformed body
const init = { method: "POST", headers: { "content-type": "application/json" }, body };

if (values["dry-run"]) {
  const r = await fetch(url, init);
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) {
    console.log(`HTTP ${r.status}, no payment asked: ${(await r.text()).slice(0, 300)}`);
    process.exit(r.ok ? 0 : 1);
  }
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  for (const a of required.accepts) {
    console.log(`price ${Number(a.amount) / 1e6} USDC (asset ${a.asset}) on ${a.network} to ${a.payTo}; tag=${a.extra?.tag ?? "none"}`);
  }
  console.log(`resource ${required.resource?.url}; bazaar=${required.extensions?.bazaar ? "yes" : "no"}`);
  process.exit(0);
}

const mnemonic = process.env.AVM_MNEMONIC?.trim();
if (!mnemonic) {
  console.error("AVM_MNEMONIC is required: the buyer account's 25 words");
  process.exit(2);
}
// Loaded only when paying, so --dry-run needs no signing libraries.
const { x402Client, wrapFetchWithPayment, x402HTTPClient } = await import("@x402/fetch");
const { toClientAvmSigner } = await import("@x402/avm");
const { ExactAvmScheme } = await import("@x402/avm/exact/client");
const { seedFromMnemonic } = await import("@algorandfoundation/algokit-utils/algo25");
const { ed25519SigningKeyFromWrappedSecret } = await import("@algorandfoundation/algokit-utils/crypto");

// The signer takes seed + public key, base64, as in the x402 Algorand examples.
const seed = seedFromMnemonic(mnemonic);
const seedCopy = new Uint8Array(seed);
const key = await ed25519SigningKeyFromWrappedSecret({ unwrapEd25519Seed: async () => seed, wrapEd25519Seed: async () => {} });
const signer = toClientAvmSigner(Buffer.concat([Buffer.from(seedCopy), Buffer.from(key.ed25519Pubkey)]).toString("base64"));
const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
console.log(`buyer ${signer.address}`);

const r = await wrapFetchWithPayment(fetch, client)(url, init);
console.log(`HTTP ${r.status}`);
console.log((await r.text()).slice(0, 1000));
if (r.ok) console.log(`payment ${JSON.stringify(new x402HTTPClient(client).getPaymentSettleResponse((name) => r.headers.get(name)))}`);
process.exitCode = r.ok ? 0 : 1;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:paywall`
Expected: PASS for all three paywall test files, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add services/paywall/scripts/pay.ts services/paywall/test/pay.test.ts services/paywall/package.json services/paywall/package-lock.json
git commit -m "feat(paywall): x402 payment client with a dry run for the TestNet and MainNet checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Milestone B done when** `npm run test:paywall` and `npm test` pass. Then the owner follows `docs/deploy/railway.md`: deploy, pay on TestNet, switch to MainNet, and make a real payment on scan and on mask. Both must then appear in the Bazaar.

---

## Part C

Part C (private chat) is added to this file before its tasks start.
