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
- End every commit message with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (pass it as a second `-m`).

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

## Parts B and C

Part B (paywall and deployment) and Part C (private chat) are added to this file before their tasks start.
