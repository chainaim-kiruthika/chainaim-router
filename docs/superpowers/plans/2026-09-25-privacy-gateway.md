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

## Part C: private chat

Chat runs the privacy pipeline on every request (spec D8). Tasks C1 to C8 build the parts, each tested alone. C9 assembles the pipeline and runs the launch gate. C10 wires the flags, the image and the documents. The OpenRouter key is not needed for any test: `scripts/stub-openrouter.ts` (C5) stands in for OpenRouter.

### Task C1: Pool cooldown fix, runtime model list and probes off

**Files:**
- Modify: `services/gateway/src/pool.ts` (replace the whole file)
- Modify: `services/gateway/src/catalog.ts` (`probe` on deployments)
- Modify: `services/gateway/src/dispatch.ts`, `services/gateway/src/server.ts`, `services/gateway/src/main.ts`, `services/gateway/test/helpers.ts`, `services/gateway/test/gateway.test.ts` (callers of the changed `Pool` API)
- Test: `services/gateway/test/pool.test.ts`
- Modify: `DEMO.md` (the cooldown known issue is fixed)

**Interfaces:**
- Consumes: `Deployment` (catalog.ts).
- Produces (`pool.ts`): `type PoolOptions` (unchanged fields); `type ModelDeployments = { id: string; deployments: readonly Deployment[] }`; `type HealthEffect = "ok" | "fail" | "cooldown" | "neutral"`; `class Pool { constructor(opts: PoolOptions); setModels(models: readonly ModelDeployments[]): void; apiKeyFor(d); unavailableModels(): string[]; isCoolingDown(modelId: string): boolean; acquire(modelId): { deployment; release(effect: HealthEffect, error?: string): void } | undefined; checkAll(); start(); stop(); status() }`. `Deployment` gains `probe?: boolean`.

The fix (spec section 7, "Cooldown fix"): a deployment is usable again once `downUntil` has passed; the next request is the trial, and one more failure sends it straight back. `"cooldown"` takes a deployment out at once whatever `unhealthyAfter` says. `"neutral"` leaves its health alone.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/pool.test.ts`:

```ts
/**
 * Deployment pool (spec section 7, "Cooldown fix"): cooldown ends by itself,
 * failures that mean "back off" act at once, the model list can change at
 * runtime, and OpenRouter deployments are never probed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Deployment } from "../src/catalog.ts";
import { Pool } from "../src/pool.ts";

const openRouter = (id: string): { id: string; deployments: Deployment[] } => ({
  id,
  deployments: [{ id: `${id}@openrouter`, adapter: "openai", baseUrl: "http://127.0.0.1:9/api/v1", servedModel: id, probe: false }],
});
const pool = (cooldownMs: number, unhealthyAfter = 1) =>
  new Pool({ healthIntervalMs: 0, healthTimeoutMs: 200, unhealthyAfter, cooldownMs, env: {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pool", () => {
  it("brings a failed model back after the cooldown, with no probe; the next request is the trial", async () => {
    const p = pool(100);
    p.setModels([openRouter("or/a:free")]);
    p.acquire("or/a:free")!.release("fail", "HTTP 500");
    assert.equal(p.isCoolingDown("or/a:free"), true);
    await sleep(150);
    assert.equal(p.isCoolingDown("or/a:free"), false, "usable again once the cooldown has passed");
    p.acquire("or/a:free")!.release("fail", "HTTP 500");
    assert.equal(p.isCoolingDown("or/a:free"), true, "a failed trial goes straight back into cooldown");
  });

  it("takes a model out at once for 'cooldown', even when unhealthyAfter is higher", () => {
    const p = pool(60_000, 3);
    p.setModels([openRouter("or/a:free")]);
    p.acquire("or/a:free")!.release("fail", "timeout");
    assert.equal(p.isCoolingDown("or/a:free"), false, "one failure of three");
    p.acquire("or/a:free")!.release("cooldown", "HTTP 429");
    assert.equal(p.isCoolingDown("or/a:free"), true);
  });

  it("leaves health alone for 'neutral' and resets it for 'ok'", () => {
    const p = pool(60_000, 2);
    p.setModels([openRouter("or/a:free")]);
    p.acquire("or/a:free")!.release("fail", "timeout");
    p.acquire("or/a:free")!.release("neutral");
    assert.equal(p.status()[0].consecutiveFailures, 1);
    p.acquire("or/a:free")!.release("ok");
    assert.equal(p.status()[0].consecutiveFailures, 0);
  });

  it("keeps the health of deployments that stay when the model list changes", () => {
    const p = pool(60_000);
    p.setModels([openRouter("or/a:free"), openRouter("or/b:free")]);
    p.acquire("or/a:free")!.release("cooldown", "HTTP 429");
    p.setModels([openRouter("or/a:free"), openRouter("or/c:free")]);
    assert.equal(p.isCoolingDown("or/a:free"), true, "a is still cooling down");
    assert.equal(p.acquire("or/b:free"), undefined, "b is gone");
    assert.equal(p.isCoolingDown("or/c:free"), false, "c is new and usable");
    assert.equal(p.isCoolingDown("or/unknown:free"), true, "an unknown model is never usable");
  });

  it("never probes a deployment with probe: false", async () => {
    const p = pool(60_000);
    p.setModels([openRouter("or/a:free")]); // its URL points at a closed port
    await p.checkAll();
    assert.equal(p.isCoolingDown("or/a:free"), false);
  });

  it("still probes catalog deployments", async () => {
    const p = pool(60_000);
    p.setModels([{ id: "local/x", deployments: [{ id: "x@0", adapter: "openai", baseUrl: "http://127.0.0.1:9/v1", servedModel: "x" }] }]);
    await p.checkAll();
    assert.equal(p.isCoolingDown("local/x"), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/pool.test.ts`
Expected: FAIL: `p.setModels is not a function` (the current `Pool` takes a catalog in its constructor).

- [ ] **Step 3: Replace `services/gateway/src/pool.ts`**

```ts
/**
 * Deployment pool: which replica of a model takes the next request, and
 * which models are cooling down.
 *
 * - Health: request outcomes count, and deployments with a probe also get a
 *   periodic GET on their healthUrl. After `unhealthyAfter` consecutive
 *   failures, or at once for failures that mean "back off", a deployment
 *   sits out for `cooldownMs`. When the cooldown ends it is usable again:
 *   the next request is the trial, and one more failure sends it back.
 * - OpenRouter deployments set probe: false; the cooldown is their only
 *   health signal.
 * - Choice: among usable deployments of a model, the one with the fewest
 *   requests in flight (ties keep list order).
 * - The model list can change at runtime (the free pool sync); deployments
 *   that stay keep their health.
 */
import type { Deployment } from "./catalog.ts";

export type PoolOptions = {
  healthIntervalMs: number;
  healthTimeoutMs: number;
  unhealthyAfter: number;
  cooldownMs: number;
  env: NodeJS.ProcessEnv;
};

export type ModelDeployments = { id: string; deployments: readonly Deployment[] };

/** What one request says about a deployment's health. */
export type HealthEffect = "ok" | "fail" | "cooldown" | "neutral";

type State = {
  deployment: Deployment;
  modelId: string;
  inFlight: number;
  consecutiveFailures: number;
  downUntil: number;
  lastError?: string;
  lastCheckedAt?: string;
};

export type DeploymentStatus = {
  id: string;
  model: string;
  healthy: boolean;
  inFlight: number;
  consecutiveFailures: number;
  lastError?: string;
  lastCheckedAt?: string;
};

export class Pool {
  private byModel = new Map<string, State[]>();
  private readonly opts: PoolOptions;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: PoolOptions) {
    this.opts = opts;
  }

  /** Replace the model list. A deployment that stays (same model, same id) keeps its health and in-flight count. */
  setModels(models: readonly ModelDeployments[]): void {
    const previous = new Map<string, State>();
    for (const states of this.byModel.values()) for (const s of states) previous.set(`${s.modelId}\u0000${s.deployment.id}`, s);
    this.byModel = new Map(
      models.map((m) => [
        m.id,
        m.deployments.map((d): State => {
          const kept = previous.get(`${m.id}\u0000${d.id}`);
          if (kept) {
            kept.deployment = d;
            return kept;
          }
          return { deployment: d, modelId: m.id, inFlight: 0, consecutiveFailures: 0, downUntil: 0 };
        }),
      ]),
    );
  }

  static healthUrlOf(d: Deployment): string {
    return d.healthUrl ?? `${d.baseUrl.replace(/\/+$/, "")}/models`;
  }

  apiKeyFor(d: Deployment): string | undefined {
    return d.apiKeyEnv ? this.opts.env[d.apiKeyEnv] : undefined;
  }

  private usable(s: State, now: number): boolean {
    return s.downUntil <= now;
  }

  /** Models with no usable deployment right now. */
  unavailableModels(): string[] {
    const now = Date.now();
    return [...this.byModel.entries()].filter(([, states]) => !states.some((s) => this.usable(s, now))).map(([id]) => id);
  }

  /** True when the model has no usable deployment now; an unknown model counts as unusable. */
  isCoolingDown(modelId: string): boolean {
    const states = this.byModel.get(modelId);
    const now = Date.now();
    return !states || !states.some((s) => this.usable(s, now));
  }

  /** Least-busy usable deployment of a model, or undefined when none is usable. */
  acquire(modelId: string): { deployment: Deployment; release: (effect: HealthEffect, error?: string) => void } | undefined {
    const states = this.byModel.get(modelId);
    if (!states) return undefined;
    const now = Date.now();
    let best: State | undefined;
    for (const s of states) {
      if (!this.usable(s, now)) continue;
      if (!best || s.inFlight < best.inFlight) best = s;
    }
    if (!best) return undefined;
    const chosen = best;
    chosen.inFlight++;
    let released = false;
    return {
      deployment: chosen.deployment,
      release: (effect: HealthEffect, error?: string) => {
        if (released) return;
        released = true;
        chosen.inFlight--;
        if (effect === "ok") this.recordSuccess(chosen);
        else if (effect === "fail") this.recordFailure(chosen, error ?? "request failed");
        else if (effect === "cooldown") this.coolDown(chosen, error ?? "cooling down");
      },
    };
  }

  private recordSuccess(s: State): void {
    s.consecutiveFailures = 0;
    s.downUntil = 0;
    s.lastError = undefined;
  }

  private recordFailure(s: State, error: string): void {
    s.consecutiveFailures++;
    s.lastError = error;
    if (s.consecutiveFailures >= this.opts.unhealthyAfter) s.downUntil = Date.now() + this.opts.cooldownMs;
  }

  /** Out at once; after the cooldown, one more failure sends it straight back. */
  private coolDown(s: State, error: string): void {
    s.consecutiveFailures = Math.max(s.consecutiveFailures + 1, this.opts.unhealthyAfter);
    s.lastError = error;
    s.downUntil = Date.now() + this.opts.cooldownMs;
  }

  private async probe(s: State): Promise<void> {
    const headers: Record<string, string> = {};
    const key = this.apiKeyFor(s.deployment);
    if (key) headers.authorization = `Bearer ${key}`;
    try {
      const res = await fetch(Pool.healthUrlOf(s.deployment), { headers, signal: AbortSignal.timeout(this.opts.healthTimeoutMs) });
      await res.body?.cancel();
      if (res.ok) this.recordSuccess(s);
      else this.recordFailure(s, `health HTTP ${res.status}`);
    } catch (e) {
      this.recordFailure(s, `health ${(e as Error).name}: ${(e as Error).message}`);
    } finally {
      s.lastCheckedAt = new Date().toISOString();
    }
  }

  /** One health round over every deployment that has a probe. */
  async checkAll(): Promise<void> {
    const probed = [...this.byModel.values()].flat().filter((s) => s.deployment.probe !== false);
    await Promise.all(probed.map((s) => this.probe(s)));
  }

  start(): void {
    if (this.opts.healthIntervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.checkAll(), this.opts.healthIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): DeploymentStatus[] {
    const now = Date.now();
    return [...this.byModel.values()].flat().map((s) => ({
      id: s.deployment.id,
      model: s.modelId,
      healthy: this.usable(s, now),
      inFlight: s.inFlight,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
      lastCheckedAt: s.lastCheckedAt,
    }));
  }
}
```

- [ ] **Step 4: Add `probe` to catalog deployments**

In `services/gateway/src/catalog.ts`, add this field to `type Deployment`, after `healthUrl`:

```ts
  /** false = never probed (OpenRouter models): request outcomes and the cooldown are its only health signal. */
  probe?: boolean;
```

In `validateCatalog`, inside the deployments loop, after the `healthUrl` check, add:

```ts
      if (d.probe !== undefined) need(typeof d.probe === "boolean", `${dat}.probe: boolean`);
```

- [ ] **Step 5: Update the callers of the old `Pool` API**

The old chat route stays until Task C9; only its calls change.

1. `services/gateway/src/dispatch.ts`:
   - add `import type { HealthEffect, Pool } from "./pool.ts";` in place of `import type { Pool } from "./pool.ts";`
   - in `type DispatchResult`, change `done: (ok: boolean, error?: string) => void` to `done: (effect: HealthEffect, error?: string) => void`
   - `release(!deploymentFault, `HTTP ${response.status}`);` becomes `release(deploymentFault ? "fail" : "ok", `HTTP ${response.status}`);`
   - in the client-abort branch, `release(true);` becomes `release("neutral");`
   - in the timeout/network branch, `release(false, error);` becomes `release("fail", error);`
2. `services/gateway/src/server.ts`: `result.done(ok, error);` becomes `result.done(ok ? "ok" : "fail", error);`
3. `services/gateway/src/main.ts`: replace `const pool = new Pool(catalog, { ... });` with the same options passed to `new Pool({ ... })`, followed by `pool.setModels(catalog.models);`
4. `services/gateway/test/helpers.ts`: in `startTestGateway`, build the pool before `createGateway` and pass it in:

```ts
  const pool = new Pool({ healthIntervalMs: 0, healthTimeoutMs: 1000, unhealthyAfter: 1, cooldownMs: 60_000, env: {} });
  pool.setModels(catalog.models);
```

   and change `pool: new Pool(catalog, { ... }),` in the deps object to `pool,`.
5. `services/gateway/test/gateway.test.ts`: in `startGateway`, replace `const pool = new Pool(catalog, { ...options });` with `const pool = new Pool({ ...options }); pool.setModels(catalog.models);` (same options).

In `DEMO.md`, delete the whole "## Known issues (as of 2026-09-22)" section (its heading, the "Delete each line once it's fixed." line and the `--cooldown-ms` bullet): the cooldown works now.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test services/gateway/test/pool.test.ts` then `npm test`
Expected: PASS, 0 failures. The existing "falls back to the next model when the primary returns 5xx" test still sees `local/small` in cooldown (`unhealthyAfter: 1`).

- [ ] **Step 7: Commit**

```bash
git add services/gateway/src/pool.ts services/gateway/src/catalog.ts services/gateway/src/dispatch.ts services/gateway/src/server.ts services/gateway/src/main.ts services/gateway/test/pool.test.ts services/gateway/test/helpers.ts services/gateway/test/gateway.test.ts DEMO.md
git commit -m "fix(pool): cooldown ends by itself; runtime model list; no probes for OpenRouter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C2: The free pool and the model source

**Files:**
- Create: `services/gateway/src/routing/freepool.ts`
- Test: `services/gateway/test/freepool.test.ts`

**Interfaces:**
- Consumes: `Catalog`, `Deployment` (catalog.ts); `ModelDeployments` (C1); `listen`, `closeServer` (test/helpers.ts).
- Produces: `type FreeModel = { id: string; contextLength: number; maxOutput: number; tools: boolean; json: boolean }`; `type ModelSource = { models(): readonly FreeModel[]; ready(): boolean }`; `parseFreeModels(body: unknown): FreeModel[]` (throws when `data` is missing); `class FreePool implements ModelSource { constructor(opts: { baseUrl: string; intervalMs: number; timeoutMs: number; onChange: (models: FreeModel[]) => void }); models(); ready(); sync(): Promise<boolean>; start(); stop() }`; `openRouterDeployments(models: readonly FreeModel[], baseUrl: string, apiKeyEnv: string): ModelDeployments[]`; `catalogSource(catalog: Catalog): ModelSource`.

Spec section 6, "Free pool": keep a model when its id ends in `:free`, its output modalities include text, and it matches none of `*content-safety*`, `stealth/*`, `openrouter/*`. Record the id, `context_length`, `top_provider.max_completion_tokens`, tools (`tools` in `supported_parameters`) and JSON output (`response_format` or `structured_outputs`). A failed sync keeps the last good list; until the first success, chat has no capacity.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/freepool.test.ts`:

```ts
/**
 * The free pool (spec section 6): which OpenRouter models count, how a sync
 * keeps the last good list, and the catalog source used for tests and local runs.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { catalogSource, FreePool, openRouterDeployments, parseFreeModels, type FreeModel } from "../src/routing/freepool.ts";
import { closeServer, listen } from "./helpers.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  context_length: 32768,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  top_provider: { context_length: 32768, max_completion_tokens: 4096 },
  supported_parameters: ["max_tokens", "tools", "response_format"],
  ...extra,
});

describe("parseFreeModels", () => {
  it("keeps a free text model and records its limits and features", () => {
    const [m] = parseFreeModels({ data: [model("acme/big-70b:free")] });
    assert.deepEqual(m, { id: "acme/big-70b:free", contextLength: 32768, maxOutput: 4096, tools: true, json: true });
  });

  it("drops paid models, excluded names and models without text output", () => {
    const got = parseFreeModels({
      data: [
        model("acme/paid-70b"),
        model("nvidia/guard-content-safety:free"),
        model("stealth/zeta:free"),
        model("openrouter/auto:free"),
        model("acme/image-gen:free", { architecture: { input_modalities: ["text"], output_modalities: ["image"] } }),
        model("acme/ok-8b:free"),
      ],
    });
    assert.deepEqual(got.map((m) => m.id), ["acme/ok-8b:free"]);
  });

  it("uses the context length when no output limit is given, and counts structured_outputs as JSON", () => {
    const [m] = parseFreeModels({ data: [model("acme/x:free", { top_provider: {}, supported_parameters: ["structured_outputs"] })] });
    assert.deepEqual([m.maxOutput, m.tools, m.json], [32768, false, true]);
  });

  it("sorts by id and rejects a body without a data array", () => {
    assert.deepEqual(parseFreeModels({ data: [model("b/y:free"), model("a/x:free")] }).map((m) => m.id), ["a/x:free", "b/y:free"]);
    assert.throws(() => parseFreeModels({}), /data/);
  });
});

describe("FreePool", () => {
  let reply: { status: number; body: unknown } = { status: 200, body: { data: [] } };
  const server = createServer((_req, res) => {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  let url = "";
  before(async () => {
    url = await listen(server);
  });
  after(() => closeServer(server));

  it("is not ready until a sync succeeds; then it lists the models and calls onChange", async () => {
    const seen: FreeModel[][] = [];
    const pool = new FreePool({ baseUrl: url, intervalMs: 0, timeoutMs: 2000, onChange: (m) => seen.push(m) });
    assert.equal(pool.ready(), false);
    reply = { status: 200, body: { data: [model("acme/a:free")] } };
    assert.equal(await pool.sync(), true);
    assert.equal(pool.ready(), true);
    assert.deepEqual(pool.models().map((m) => m.id), ["acme/a:free"]);
    assert.equal(seen.length, 1);
  });

  it("keeps the last good list when a sync fails or finds nothing", async () => {
    const pool = new FreePool({ baseUrl: url, intervalMs: 0, timeoutMs: 2000, onChange: () => {} });
    reply = { status: 200, body: { data: [model("acme/a:free")] } };
    await pool.sync();
    for (const r of [{ status: 500, body: {} }, { status: 200, body: { data: [] } }, { status: 200, body: { oops: true } }]) {
      reply = r;
      assert.equal(await pool.sync(), false);
      assert.deepEqual(pool.models().map((m) => m.id), ["acme/a:free"]);
    }
  });

  it("fails a sync when OpenRouter cannot be reached", async () => {
    const pool = new FreePool({ baseUrl: "http://127.0.0.1:9", intervalMs: 0, timeoutMs: 300, onChange: () => {} });
    assert.equal(await pool.sync(), false);
    assert.equal(pool.ready(), false);
  });
});

describe("model sources", () => {
  it("gives each OpenRouter model one unprobed deployment that reads the key variable", () => {
    const [d] = openRouterDeployments([{ id: "acme/a:free", contextLength: 1, maxOutput: 1, tools: false, json: false }], "https://openrouter.ai/", "OPENROUTER_API_KEY");
    assert.deepEqual(d, {
      id: "acme/a:free",
      deployments: [{ id: "acme/a:free@openrouter", adapter: "openai", baseUrl: "https://openrouter.ai/api/v1", servedModel: "acme/a:free", apiKeyEnv: "OPENROUTER_API_KEY", probe: false }],
    });
  });

  it("turns the catalog into an always-ready source", () => {
    const source = catalogSource(loadCatalog("config/catalog.json"));
    assert.equal(source.ready(), true);
    assert.deepEqual(source.models().map((m) => m.id), ["local/qwen2.5-0.5b", "local/qwen2.5-1.5b"]);
    assert.equal(source.models()[0].contextLength, 4096);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/freepool.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/routing/freepool.ts`.

- [ ] **Step 3: Write the implementation**

Create `services/gateway/src/routing/freepool.ts`:

```ts
/**
 * Where chat models come from. In production: OpenRouter's free models,
 * synced from the public model list every few hours (no key needed). A
 * failed sync keeps the last good list, and until the first success chat
 * has no capacity. In catalog mode (tests, local runs): the static catalog.
 */
import type { Catalog, Deployment } from "../catalog.ts";
import type { ModelDeployments } from "../pool.ts";

export type FreeModel = { id: string; contextLength: number; maxOutput: number; tools: boolean; json: boolean };
export type ModelSource = { models(): readonly FreeModel[]; ready(): boolean };

const EXCLUDED = [/content-safety/, /^stealth\//, /^openrouter\//];

type RawModel = {
  id?: unknown;
  context_length?: unknown;
  architecture?: { output_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown };
  supported_parameters?: unknown;
};

/** The free chat models in a GET /api/v1/models body, sorted by id. */
export function parseFreeModels(body: unknown): FreeModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("models list: no data array");
  const out: FreeModel[] = [];
  for (const m of data as RawModel[]) {
    const id = m?.id;
    if (typeof id !== "string" || !id.endsWith(":free") || EXCLUDED.some((re) => re.test(id))) continue;
    const outputs = m.architecture?.output_modalities;
    if (!Array.isArray(outputs) || !outputs.includes("text")) continue;
    const contextLength = m.context_length;
    if (typeof contextLength !== "number" || !Number.isInteger(contextLength) || contextLength <= 0) continue;
    const maxOut = m.top_provider?.max_completion_tokens;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    out.push({
      id,
      contextLength,
      maxOutput: typeof maxOut === "number" && Number.isInteger(maxOut) && maxOut > 0 ? maxOut : contextLength,
      tools: params.includes("tools"),
      json: params.includes("response_format") || params.includes("structured_outputs"),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type FreePoolOptions = { baseUrl: string; intervalMs: number; timeoutMs: number; onChange: (models: FreeModel[]) => void };

export class FreePool implements ModelSource {
  private list: FreeModel[] = [];
  private synced = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly opts: FreePoolOptions;

  constructor(opts: FreePoolOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
  }

  models(): readonly FreeModel[] {
    return this.list;
  }

  ready(): boolean {
    return this.synced && this.list.length > 0;
  }

  /** Fetch the model list; true when it replaced the current one. */
  async sync(): Promise<boolean> {
    let models: FreeModel[];
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/v1/models`, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      if (!res.ok) {
        await res.body?.cancel();
        return false;
      }
      models = parseFreeModels(await res.json());
    } catch {
      return false;
    }
    if (models.length === 0) return false; // an empty list is a bad sync, not a real lineup
    this.list = models;
    this.synced = true;
    this.opts.onChange(models);
    return true;
  }

  start(): void {
    if (this.timer || this.opts.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.sync(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Pool entries for OpenRouter models: one deployment each, never probed. */
export function openRouterDeployments(models: readonly FreeModel[], baseUrl: string, apiKeyEnv: string): ModelDeployments[] {
  const root = `${baseUrl.replace(/\/+$/, "")}/api/v1`;
  return models.map((m) => {
    const deployment: Deployment = { id: `${m.id}@openrouter`, adapter: "openai", baseUrl: root, servedModel: m.id, apiKeyEnv, probe: false };
    return { id: m.id, deployments: [deployment] };
  });
}

/** Catalog mode: the static catalog's models, always ready. The catalog does not say whether a model returns JSON, so it is assumed. */
export function catalogSource(catalog: Catalog): ModelSource {
  const list: FreeModel[] = catalog.models.map((m) => ({
    id: m.id,
    contextLength: m.capabilities.contextWindow,
    maxOutput: m.capabilities.maxOutputTokens,
    tools: m.capabilities.supportsTools,
    json: true,
  }));
  return { models: () => list, ready: () => list.length > 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test services/gateway/test/freepool.test.ts`
Expected: PASS, 9 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/routing/freepool.ts services/gateway/test/freepool.test.ts
git commit -m "feat(routing): free pool sync from OpenRouter and the catalog model source" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C3: The scoring table

**Files:**
- Create: `config/free-models.json`
- Create: `services/gateway/src/routing/scores.ts`
- Test: `services/gateway/test/scores.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TASKS = ["chat", "extraction", "rewrite", "code", "reasoning", "tool_use", "long_document"] as const`; `type Task`; `SPEEDS = ["fast", "medium", "slow"] as const`; `type Speed`; `SPEED_RANK: Record<Speed, number>` (fast 0, medium 1, slow 2); `type ModelScore = { quality: number; tasks: string[]; speed: Speed; domains: string[] }`; `type ScoreTable`; `validateScoreTable(raw: unknown): ScoreTable`; `loadScoreTable(path: string): ScoreTable`; `sizeOf(id: string): number | undefined`; `entryFor(table: ScoreTable, id: string): ModelScore`; `scoreOf(table: ScoreTable, entry: ModelScore, req: { task: Task; difficulty: number; phi: boolean }): number`.

Spec section 6, "Scoring table": for difficulty d (1 to 5), score = quality × qualityByDifficulty[d − 1] + (task in the model's tasks ? taskMatch : 0) + (PHI and "health" in its domains ? domainMatch : 0) + (d ≤ 2 ? speedWhenEasy[speed] : 0). A model missing from the table takes its quality and speed from the largest `<number>b` in its id, using the first row whose threshold it meets; with no size, the unknown-size defaults, and no tasks or domains.

- [ ] **Step 1: Write the table**

Create `config/free-models.json` (the spec's seed; estimates to be tuned from ledger data in October):

```json
{
  "version": "2026-09-24",
  "notes": "Scoring table for OpenRouter's free models (spec section 6). Quality, tasks and speed are estimates, to be tuned from ledger data. A model missing here is scored from the largest <number>b in its id.",
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
    "nvidia/nemotron-3-ultra-550b-a55b:free": { "quality": 9, "tasks": ["reasoning", "code", "long_document"], "speed": "slow", "domains": [] },
    "nvidia/nemotron-3-super-120b-a12b:free": { "quality": 8, "tasks": ["reasoning", "tool_use", "code"], "speed": "medium", "domains": [] },
    "z-ai/glm-5.2:free": { "quality": 8, "tasks": ["reasoning", "code", "chat"], "speed": "medium", "domains": [] },
    "thinkingmachines/inkling:free": { "quality": 8, "tasks": ["reasoning", "chat", "long_document"], "speed": "medium", "domains": [] },
    "qwen/qwen3.8-27b:free": { "quality": 7, "tasks": ["chat", "code", "reasoning", "tool_use", "extraction"], "speed": "medium", "domains": [] },
    "google/gemma-4-31b-it:free": { "quality": 7, "tasks": ["chat", "rewrite", "extraction"], "speed": "medium", "domains": [] },
    "nex-agi/nex-n2.5-pro:free": { "quality": 7, "tasks": ["tool_use", "reasoning", "code"], "speed": "medium", "domains": [] },
    "poolside/laguna-s-2.1:free": { "quality": 7, "tasks": ["code", "tool_use"], "speed": "medium", "domains": [] },
    "google/gemma-4-26b-a4b-it:free": { "quality": 6, "tasks": ["chat", "rewrite", "extraction"], "speed": "fast", "domains": [] },
    "dots-studio/dots-3-note-preview:free": { "quality": 6, "tasks": ["long_document", "chat"], "speed": "medium", "domains": [] },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { "quality": 6, "tasks": ["reasoning"], "speed": "fast", "domains": [] },
    "nvidia/nemotron-3.5-lightning:free": { "quality": 6, "tasks": ["chat", "extraction", "long_document"], "speed": "fast", "domains": [] },
    "thinkingmachines/inkling-small:free": { "quality": 6, "tasks": ["chat", "rewrite", "long_document"], "speed": "fast", "domains": [] },
    "inclusionai/ling-3.0-flash-sante:free": { "quality": 5, "tasks": ["chat", "extraction"], "speed": "fast", "domains": ["health"] },
    "inclusionai/ling-3.0-flash-fin:free": { "quality": 5, "tasks": ["extraction", "chat"], "speed": "fast", "domains": [] },
    "cohere/north-mini-code:free": { "quality": 5, "tasks": ["code"], "speed": "fast", "domains": [] },
    "nex-agi/nex-n2.5-mini:free": { "quality": 5, "tasks": ["tool_use", "chat"], "speed": "fast", "domains": [] },
    "poolside/laguna-xs-2.1:free": { "quality": 5, "tasks": ["code"], "speed": "fast", "domains": [] },
    "liquid/lfm-2.5-2.6b:free": { "quality": 3, "tasks": ["chat", "extraction", "rewrite"], "speed": "fast", "domains": [] }
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `services/gateway/test/scores.test.ts`:

```ts
/**
 * The scoring table (spec section 6): size defaults for unlisted models, the
 * score formula, and validation of config/free-models.json.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { entryFor, loadScoreTable, scoreOf, sizeOf, TASKS, validateScoreTable } from "../src/routing/scores.ts";

describe("sizeOf", () => {
  const cases: [string, number | undefined][] = [
    ["nvidia/nemotron-3-ultra-550b-a55b:free", 550],
    ["qwen/qwen3.8-27b:free", 27],
    ["liquid/lfm-2.5-2.6b:free", 2.6],
    ["google/gemma-4-26b-a4b-it:free", 26],
    ["nvidia/nemotron-3-super-120b-a12b:free", 120],
    ["z-ai/glm-5.2:free", undefined],
  ];
  for (const [id, want] of cases) it(id, () => assert.equal(sizeOf(id), want));
});

describe("the shipped table", () => {
  const table = loadScoreTable("config/free-models.json");

  it("lists the spec's 19 free models, each with valid tasks", () => {
    assert.equal(Object.keys(table.models).length, 19);
    for (const [id, m] of Object.entries(table.models)) {
      assert.ok(id.endsWith(":free"), id);
      for (const t of m.tasks) assert.ok((TASKS as readonly string[]).includes(t), `${id}: ${t}`);
    }
  });

  it("marks the health model's domain", () => {
    assert.deepEqual(table.models["inclusionai/ling-3.0-flash-sante:free"].domains, ["health"]);
  });

  it("scores an unlisted model from the size in its id", () => {
    assert.deepEqual(entryFor(table, "acme/giant-400b:free"), { quality: 8, speed: "slow", tasks: [], domains: [] });
    assert.deepEqual(entryFor(table, "acme/mid-30b:free"), { quality: 6, speed: "medium", tasks: [], domains: [] });
    assert.deepEqual(entryFor(table, "acme/mini-3b:free"), { quality: 3, speed: "fast", tasks: [], domains: [] });
    assert.deepEqual(entryFor(table, "acme/mystery:free"), { quality: 5, speed: "medium", tasks: [], domains: [] });
  });

  it("follows the spec's formula", () => {
    const qwen = entryFor(table, "qwen/qwen3.8-27b:free"); // quality 7, medium
    assert.equal(scoreOf(table, qwen, { task: "code", difficulty: 2, phi: false }), 7 * 0.75 + 2 + 1);
    assert.equal(scoreOf(table, qwen, { task: "rewrite", difficulty: 4, phi: false }), 7 * 1.25);
    const sante = entryFor(table, "inclusionai/ling-3.0-flash-sante:free"); // quality 5, fast, health
    assert.equal(scoreOf(table, sante, { task: "chat", difficulty: 1, phi: true }), 5 * 0.5 + 2 + 2 + 2);
    assert.equal(scoreOf(table, sante, { task: "chat", difficulty: 1, phi: false }), 5 * 0.5 + 2 + 2);
  });
});

describe("validateScoreTable", () => {
  const shipped = () => JSON.parse(readFileSync("config/free-models.json", "utf8"));

  it("rejects an unknown task and an unknown speed", () => {
    const t = shipped();
    t.models["qwen/qwen3.8-27b:free"].tasks = ["poetry"];
    assert.throws(() => validateScoreTable(t), /tasks/);
    const u = shipped();
    u.models["qwen/qwen3.8-27b:free"].speed = "warp";
    assert.throws(() => validateScoreTable(u), /speed/);
  });

  it("rejects a size table that does not end at 0 and a weight list of the wrong length", () => {
    const t = shipped();
    t.defaults.qualityBySize = [[100, 7]];
    assert.throws(() => validateScoreTable(t), /qualityBySize/);
    const u = shipped();
    u.weights.qualityByDifficulty = [1, 1, 1];
    assert.throws(() => validateScoreTable(u), /qualityByDifficulty/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test services/gateway/test/scores.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/routing/scores.ts`.

- [ ] **Step 4: Write the implementation**

Create `services/gateway/src/routing/scores.ts`:

```ts
/**
 * The scoring table (spec section 6): how well each free model does each kind
 * of task, and the formula that ranks them for one request. Unlisted models
 * are scored from the size in their id.
 */
import { readFileSync } from "node:fs";

export const TASKS = ["chat", "extraction", "rewrite", "code", "reasoning", "tool_use", "long_document"] as const;
export type Task = (typeof TASKS)[number];
export const SPEEDS = ["fast", "medium", "slow"] as const;
export type Speed = (typeof SPEEDS)[number];
/** Tie-break order: the faster speed class wins. */
export const SPEED_RANK: Record<Speed, number> = { fast: 0, medium: 1, slow: 2 };

export type ModelScore = { quality: number; tasks: string[]; speed: Speed; domains: string[] };
export type ScoreTable = {
  version: string;
  weights: { qualityByDifficulty: number[]; taskMatch: number; domainMatch: number; speedWhenEasy: Record<Speed, number> };
  defaults: { qualityBySize: [number, number][]; unknownSizeQuality: number; speedBySize: [number, Speed][]; unknownSizeSpeed: Speed };
  models: Record<string, ModelScore>;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSpeed = (v: unknown): v is Speed => (SPEEDS as readonly unknown[]).includes(v);

/** [minimum size in billions, value] rows, largest first, ending at 0. */
function sizeRows(v: unknown, valueOk: (x: unknown) => boolean): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && valueOk(r[1])) && v[v.length - 1][0] === 0;
}

export function validateScoreTable(raw: unknown): ScoreTable {
  const need = (ok: unknown, message: string): void => {
    if (!ok) throw new Error(`score table: ${message}`);
  };
  need(isObj(raw), "must be a JSON object");
  const t = raw as Record<string, unknown>;
  need(typeof t.version === "string", "version: string required");
  const w = t.weights as Record<string, unknown>;
  need(isObj(w), "weights: object required");
  const q = w.qualityByDifficulty;
  need(Array.isArray(q) && q.length === 5 && q.every((x) => typeof x === "number"), "weights.qualityByDifficulty: five numbers");
  need(typeof w.taskMatch === "number" && typeof w.domainMatch === "number", "weights.taskMatch and weights.domainMatch: numbers");
  const easy = w.speedWhenEasy as Record<string, unknown>;
  need(isObj(easy) && SPEEDS.every((s) => typeof easy[s] === "number"), "weights.speedWhenEasy: a number for fast, medium and slow");
  const d = t.defaults as Record<string, unknown>;
  need(isObj(d), "defaults: object required");
  need(sizeRows(d.qualityBySize, (x) => typeof x === "number"), "defaults.qualityBySize: [minBillions, quality] rows ending at 0");
  need(sizeRows(d.speedBySize, isSpeed), "defaults.speedBySize: [minBillions, speed] rows ending at 0");
  need(typeof d.unknownSizeQuality === "number", "defaults.unknownSizeQuality: number");
  need(isSpeed(d.unknownSizeSpeed), "defaults.unknownSizeSpeed: fast, medium or slow");
  need(isObj(t.models), "models: object required");
  for (const [id, m] of Object.entries(t.models as Record<string, unknown>)) {
    const e = m as Record<string, unknown>;
    need(isObj(m) && typeof e.quality === "number", `models.${id}.quality: number`);
    need(Array.isArray(e.tasks) && e.tasks.every((x) => (TASKS as readonly unknown[]).includes(x)), `models.${id}.tasks: from ${TASKS.join(", ")}`);
    need(isSpeed(e.speed), `models.${id}.speed: fast, medium or slow`);
    need(Array.isArray(e.domains) && e.domains.every((x) => typeof x === "string"), `models.${id}.domains: array of strings`);
  }
  return raw as ScoreTable;
}

export function loadScoreTable(path: string): ScoreTable {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read score table ${path}: ${(e as Error).message}`);
  }
  return validateScoreTable(raw);
}

/** The largest "<number>b" in a model id, e.g. 550 for "nvidia/nemotron-3-ultra-550b-a55b:free". */
export function sizeOf(id: string): number | undefined {
  let best: number | undefined;
  for (const m of id.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)b(?![a-z0-9])/gi)) {
    const n = Number(m[1]);
    if (best === undefined || n > best) best = n;
  }
  return best;
}

/** The table's entry for a model, or one built from the size in its id. */
export function entryFor(table: ScoreTable, id: string): ModelScore {
  const listed = table.models[id];
  if (listed) return listed;
  const size = sizeOf(id);
  const d = table.defaults;
  if (size === undefined) return { quality: d.unknownSizeQuality, speed: d.unknownSizeSpeed, tasks: [], domains: [] };
  const quality = d.qualityBySize.find(([min]) => size >= min)?.[1] ?? d.unknownSizeQuality;
  const speed = d.speedBySize.find(([min]) => size >= min)?.[1] ?? d.unknownSizeSpeed;
  return { quality, speed, tasks: [], domains: [] };
}

export function scoreOf(table: ScoreTable, entry: ModelScore, req: { task: Task; difficulty: number; phi: boolean }): number {
  const w = table.weights;
  return (
    entry.quality * w.qualityByDifficulty[req.difficulty - 1] +
    (entry.tasks.includes(req.task) ? w.taskMatch : 0) +
    (req.phi && entry.domains.includes("health") ? w.domainMatch : 0) +
    (req.difficulty <= 2 ? w.speedWhenEasy[entry.speed] : 0)
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test services/gateway/test/scores.test.ts`
Expected: PASS, 12 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add config/free-models.json services/gateway/src/routing/scores.ts services/gateway/test/scores.test.ts
git commit -m "feat(routing): free-model scoring table with size defaults" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C4: Eligibility filters, ranking and the deny-unavailable cache

**Files:**
- Create: `services/gateway/src/routing/select.ts`
- Test: `services/gateway/test/select.test.ts`

**Interfaces:**
- Consumes: `FreeModel` (C2); `ScoreTable`, `Task`, `entryFor`, `scoreOf`, `SPEED_RANK`, `validateScoreTable` (C3).
- Produces: `type Need = { task: Task; difficulty: number; phi: boolean; hasTools: boolean; wantsJson: boolean; promptTokens: number; maxTokens: number }`; `type Excluders = { coolingDown(id: string): boolean; denyUnavailable(id: string): boolean }`; `failedFilter(m: FreeModel, need: Need, ex: Excluders): "tools" | "response_format" | "context_length" | "max_output_tokens" | "data_policy" | "cooling_down" | undefined`; `rank(models: readonly FreeModel[], table: ScoreTable, need: Need, ex: Excluders): { ranked: { id: string; score: number }[]; excluded: Record<string, string> }`; `class ExpiringSet { constructor(ttlMs: number); add(id: string, now?: number): void; has(id: string, now?: number): boolean }`.

Spec section 6, "Eligibility filters": tools attached needs tool support; `response_format` needs JSON output; estimated prompt tokens plus `max_tokens` fit the context, and `max_tokens` fits the model's maximum output; a PHI request skips models in the deny-unavailable cache; cooling-down models are skipped. Ties go to the faster speed class, then the alphabetically first id.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/select.test.ts`:

```ts
/**
 * Eligibility filters and ranking (spec section 6).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FreeModel } from "../src/routing/freepool.ts";
import { validateScoreTable } from "../src/routing/scores.ts";
import { ExpiringSet, failedFilter, rank, type Need } from "../src/routing/select.ts";

const table = validateScoreTable({
  version: "test",
  weights: { qualityByDifficulty: [0.5, 0.75, 1.0, 1.25, 1.5], taskMatch: 2, domainMatch: 2, speedWhenEasy: { fast: 2, medium: 1, slow: 0 } },
  defaults: { qualityBySize: [[300, 8], [100, 7], [25, 6], [8, 5], [0, 3]], unknownSizeQuality: 5, speedBySize: [[100, "slow"], [25, "medium"], [0, "fast"]], unknownSizeSpeed: "medium" },
  models: {
    "a/slowpoke:free": { quality: 6, tasks: ["chat"], speed: "slow", domains: [] },
    "b/quick:free": { quality: 6, tasks: ["chat"], speed: "fast", domains: [] },
    "c/one:free": { quality: 6, tasks: ["chat"], speed: "fast", domains: [] },
    "d/strong:free": { quality: 9, tasks: ["reasoning"], speed: "slow", domains: [] },
    "e/health:free": { quality: 5, tasks: ["chat"], speed: "fast", domains: ["health"] },
  },
});
const m = (id: string, extra: Partial<FreeModel> = {}): FreeModel => ({ id, contextLength: 32768, maxOutput: 4096, tools: true, json: true, ...extra });
const need = (extra: Partial<Need> = {}): Need => ({ task: "chat", difficulty: 3, phi: false, hasTools: false, wantsJson: false, promptTokens: 100, maxTokens: 1024, ...extra });
const none = { coolingDown: () => false, denyUnavailable: () => false };

describe("failedFilter", () => {
  it("names the first filter a model fails", () => {
    assert.equal(failedFilter(m("x", { tools: false }), need({ hasTools: true }), none), "tools");
    assert.equal(failedFilter(m("x", { json: false }), need({ wantsJson: true }), none), "response_format");
    assert.equal(failedFilter(m("x", { contextLength: 1000 }), need(), none), "context_length");
    assert.equal(failedFilter(m("x", { maxOutput: 512 }), need(), none), "max_output_tokens");
    assert.equal(failedFilter(m("x"), need({ phi: true }), { ...none, denyUnavailable: () => true }), "data_policy");
    assert.equal(failedFilter(m("x"), need(), { ...none, coolingDown: () => true }), "cooling_down");
    assert.equal(failedFilter(m("x"), need(), none), undefined);
  });

  it("checks the deny-unavailable cache only for PHI", () => {
    assert.equal(failedFilter(m("x"), need({ phi: false }), { ...none, denyUnavailable: () => true }), undefined);
  });
});

describe("rank", () => {
  it("orders by score, then the faster speed class, then the id", () => {
    // chat at difficulty 3: a, b and c score 6 + 2 = 8; d scores 9 with no task match
    const { ranked } = rank([m("a/slowpoke:free"), m("c/one:free"), m("b/quick:free"), m("d/strong:free")], table, need(), none);
    assert.deepEqual(ranked.map((r) => r.id), ["d/strong:free", "b/quick:free", "c/one:free", "a/slowpoke:free"]);
    assert.equal(ranked[0].score, 9);
  });

  it("gives the health model the edge on a PHI request", () => {
    const { ranked } = rank([m("b/quick:free"), m("e/health:free")], table, need({ difficulty: 1, phi: true }), none);
    assert.equal(ranked[0].id, "e/health:free");
  });

  it("reports why each excluded model was left out", () => {
    const { ranked, excluded } = rank([m("b/quick:free", { tools: false }), m("c/one:free")], table, need({ hasTools: true }), none);
    assert.deepEqual(ranked.map((r) => r.id), ["c/one:free"]);
    assert.deepEqual(excluded, { "b/quick:free": "tools" });
  });
});

describe("ExpiringSet", () => {
  it("forgets an entry after its time to live", () => {
    const s = new ExpiringSet(1000);
    s.add("x", 0);
    assert.equal(s.has("x", 999), true);
    assert.equal(s.has("x", 1000), false);
    assert.equal(s.has("y", 0), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/select.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/routing/select.ts`.

- [ ] **Step 3: Write the implementation**

Create `services/gateway/src/routing/select.ts`:

```ts
/**
 * Which free models may serve a request, and in what order (spec section 6).
 * Pure functions, plus the cache of models that have no provider meeting the
 * no-collection data policy.
 */
import type { FreeModel } from "./freepool.ts";
import { entryFor, scoreOf, SPEED_RANK, type ScoreTable, type Task } from "./scores.ts";

export type Need = { task: Task; difficulty: number; phi: boolean; hasTools: boolean; wantsJson: boolean; promptTokens: number; maxTokens: number };
export type Excluders = { coolingDown: (id: string) => boolean; denyUnavailable: (id: string) => boolean };
export type Filter = "tools" | "response_format" | "context_length" | "max_output_tokens" | "data_policy" | "cooling_down";

/** The first eligibility filter a model fails, or undefined when it may serve the request. */
export function failedFilter(m: FreeModel, need: Need, ex: Excluders): Filter | undefined {
  if (need.hasTools && !m.tools) return "tools";
  if (need.wantsJson && !m.json) return "response_format";
  if (need.promptTokens + need.maxTokens > m.contextLength) return "context_length";
  if (need.maxTokens > m.maxOutput) return "max_output_tokens";
  if (need.phi && ex.denyUnavailable(m.id)) return "data_policy";
  if (ex.coolingDown(m.id)) return "cooling_down";
  return undefined;
}

/** Eligible models, best first, and why the others were left out. */
export function rank(models: readonly FreeModel[], table: ScoreTable, need: Need, ex: Excluders): { ranked: { id: string; score: number }[]; excluded: Record<string, string> } {
  const excluded: Record<string, string> = {};
  const scored: { id: string; score: number; speed: number }[] = [];
  for (const m of models) {
    const why = failedFilter(m, need, ex);
    if (why) {
      excluded[m.id] = why;
      continue;
    }
    const entry = entryFor(table, m.id);
    scored.push({ id: m.id, score: scoreOf(table, entry, need), speed: SPEED_RANK[entry.speed] });
  }
  scored.sort((a, b) => b.score - a.score || a.speed - b.speed || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ranked: scored.map(({ id, score }) => ({ id, score })), excluded };
}

/** A set whose entries expire: the deny-unavailable cache (spec section 7, 6 hours in production). */
export class ExpiringSet {
  private readonly until = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  add(id: string, now = Date.now()): void {
    this.until.set(id, now + this.ttlMs);
  }

  has(id: string, now = Date.now()): boolean {
    const t = this.until.get(id);
    if (t === undefined) return false;
    if (t <= now) {
      this.until.delete(id);
      return false;
    }
    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test services/gateway/test/select.test.ts`
Expected: PASS, 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/routing/select.ts services/gateway/test/select.test.ts
git commit -m "feat(routing): eligibility filters, ranking and the deny-unavailable cache" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C5: Stub OpenRouter, request shaping, failure categories and one model attempt

**Files:**
- Create: `scripts/stub-openrouter.ts`
- Create: `services/gateway/src/openrouter.ts`
- Modify: `services/gateway/src/dispatch.ts` (append `attemptChat`; the old `dispatch` stays until C9)
- Test: `services/gateway/test/openrouter.test.ts`
- Modify: `package.json` (root: `stub-openrouter` script)

**Interfaces:**
- Consumes: `Pool`, `HealthEffect` (C1); `openRouterDeployments`, `parseFreeModels` (C2).
- Produces:
  - `scripts/stub-openrouter.ts`: `type ChatMode = "ok" | "account429" | "account429day" | "provider429" | "policy404" | "policy503" | "unauthorized" | "server500" | "badrequest" | "slow" | "notjson"`; `type JevMode = "ok" | "slow" | "fail500" | "malformed"`; `type StubOpenRouter = { url: string; models: unknown[]; chatModes: Record<string, ChatMode>; chatBodies: Record<string, unknown>[]; decisionBodies: Record<string, unknown>[]; authorizations: string[]; jev: { mode: JevMode; task: string; difficulty: number; health: number }; key: { status: number; remaining: number }; keyReads: number; close(): Promise<void> }`; `STUB_MODELS: readonly unknown[]` (usable: `stub/alpha-70b:free` tools+json, `stub/bravo-27b:free` tools, `stub/charlie-8b:free` neither; excluded: a content-safety model, a `stealth/` model, a paid model); `startStubOpenRouter(port?, host?): Promise<StubOpenRouter>`.
  - `openrouter.ts`: `type DataCollection = "allow" | "deny"`; `type Outcome = "ok" | "rate_limited_account" | "rate_limited_provider" | "data_policy_unavailable" | "key_rejected" | "upstream_error" | "timeout" | "network_error" | "client_abort" | "no_deployment"`; `PASSTHROUGH` (readonly field names); `shapeBody(request: Readonly<Record<string, unknown>>, messages: readonly unknown[], maxTokens: number): Record<string, unknown>`; `REQUEST_FAULTS: ReadonlySet<number>` (400, 413, 422); `type Categorized = { outcome: Outcome; accountScope?: "minute" | "day" }`; `categorize(status: number, text: string, dataCollection: DataCollection): Categorized`.
  - `dispatch.ts`: `type ModelAttempt = { model: string; outcome: Outcome; status?: number; ms: number }`; `type AttemptResult = { attempt: ModelAttempt; completion?: Record<string, unknown>; accountScope?: "minute" | "day" }`; `attemptChat(model: string, body: Record<string, unknown>, dataCollection: DataCollection, pool: Pool, timeoutMs: number, clientSignal: AbortSignal): Promise<AttemptResult>`.

Spec section 7 and the plan's refinements 4 to 6: account-level 429s stop the chain; provider 429s and 5xx cool the model down; a data-policy refusal (404 or 503 naming the data policy or routing requirements, on a deny request) caches the model; 401, and 403 without moderation metadata, mean the key was rejected; a request-caused 4xx does not cool the model down. Upstream calls are never streamed. The health update happens in `attemptChat`; quota and the cache are the caller's (C9).

- [ ] **Step 1: Write the stub OpenRouter**

Create `scripts/stub-openrouter.ts`:

```ts
/**
 * Stub OpenRouter for tests and local runs: the public model list, the key
 * endpoint, chat completions and the Decisions API (Jev). It records every
 * body it receives, so tests can prove what left the gateway.
 *
 *   node scripts/stub-openrouter.ts [--port 5003]
 *
 * Chat behaviour per model id (chatModes, default "ok"):
 *   ok             "echo: <last user text>"; with tools and "call lookup" in the
 *                  last user text, a lookup tool call carrying that text instead
 *   account429     429 free-models-per-min      account429day  429 free-models-per-day
 *   provider429    429 with metadata.provider_name
 *   policy404      404 data policy, for deny requests (allow requests are served)
 *   policy503      503 routing requirements, for deny requests
 *   unauthorized   401     server500   500     badrequest   400
 *   slow           answers after 1.5 s     notjson   200 with a body that is not JSON
 * Jev (jev.mode): ok | slow | fail500 | malformed, answering jev.task,
 * jev.difficulty (1 to 5) and jev.health.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

export type ChatMode = "ok" | "account429" | "account429day" | "provider429" | "policy404" | "policy503" | "unauthorized" | "server500" | "badrequest" | "slow" | "notjson";
export type JevMode = "ok" | "slow" | "fail500" | "malformed";
export type StubOpenRouter = {
  url: string;
  models: unknown[];
  chatModes: Record<string, ChatMode>;
  chatBodies: Record<string, unknown>[];
  decisionBodies: Record<string, unknown>[];
  authorizations: string[];
  jev: { mode: JevMode; task: string; difficulty: number; health: number };
  key: { status: number; remaining: number };
  keyReads: number;
  close: () => Promise<void>;
};

const freeModel = (id: string, contextLength: number, maxOut: number, params: string[]) => ({
  id,
  name: id,
  context_length: contextLength,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0", completion: "0" },
  top_provider: { context_length: contextLength, max_completion_tokens: maxOut },
  supported_parameters: params,
});

/** Three usable free models, and three the gateway must leave out. */
export const STUB_MODELS: readonly unknown[] = [
  freeModel("stub/alpha-70b:free", 131072, 8192, ["max_tokens", "tools", "tool_choice", "response_format"]),
  freeModel("stub/bravo-27b:free", 65536, 4096, ["max_tokens", "tools", "tool_choice"]),
  freeModel("stub/charlie-8b:free", 32768, 2048, ["max_tokens"]),
  freeModel("stub/guard-content-safety:free", 8192, 1024, ["max_tokens"]),
  freeModel("stealth/zeta:free", 8192, 1024, ["max_tokens"]),
  { ...freeModel("stub/paid-model", 8192, 1024, ["max_tokens"]), pricing: { prompt: "0.000001", completion: "0.000002" } },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const error = (code: number, message: string, metadata: Record<string, unknown> = {}) => ({ error: { code, message, metadata } });

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((p: { text?: string }) => p?.text ?? "").join("\n");
  }
  return "";
}

function completion(body: Record<string, unknown>): unknown {
  const text = lastUserText(body);
  const toolCall = Array.isArray(body.tools) && body.tools.length > 0 && text.includes("call lookup");
  const message = toolCall
    ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ query: text }) } }] }
    : { role: "assistant", content: `echo: ${text}` };
  return {
    id: "gen-stub-1",
    object: "chat.completion",
    created: 1790000000,
    model: body.model,
    provider: "StubCloud",
    choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function decision(jev: StubOpenRouter["jev"]): unknown {
  const difficulty = Object.fromEntries([0, 1, 2, 3, 4].map((i) => [String(i), i === jev.difficulty - 1 ? 0.9 : 0.025]));
  return {
    id: "gen-dec-stub",
    model: "typesafe/jev-1.13-20260901",
    provider: "TypeSafe",
    answers: {
      task: { type: "choice", choice: jev.task, probabilities: { [jev.task]: 0.9 }, confidence: 0.8 },
      difficulty: { type: "score", score: jev.difficulty - 1, probabilities: difficulty, confidence: 0.9 },
      health: { type: "noul", noul: jev.health },
    },
    usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 },
  };
}

export function startStubOpenRouter(port = 0, host = "127.0.0.1"): Promise<StubOpenRouter> {
  const stub: StubOpenRouter = {
    url: "",
    models: [...STUB_MODELS],
    chatModes: {},
    chatBodies: [],
    decisionBodies: [],
    authorizations: [],
    jev: { mode: "ok", task: "chat", difficulty: 1, health: 0.05 },
    key: { status: 200, remaining: 1000 },
    keyReads: 0,
    close: async () => {},
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://stub.local").pathname;
    if (req.method === "GET" && path === "/api/v1/models") return json(res, 200, { data: stub.models });
    const auth = req.headers.authorization ?? "";
    stub.authorizations.push(auth);
    if (!auth.startsWith("Bearer ")) return json(res, 401, error(401, "No auth credentials found"));

    if (req.method === "GET" && path === "/api/v1/key") {
      stub.keyReads++;
      if (stub.key.status !== 200) return json(res, stub.key.status, error(stub.key.status, "stub key status"));
      const daily = { used: 1000 - stub.key.remaining, limit: 1000, remaining: stub.key.remaining };
      return json(res, 200, { data: { label: "stub", limit: null, usage: 0, is_free_tier: false, free_model_daily_requests: daily } });
    }

    if (req.method === "POST" && path === "/api/alpha/decisions") {
      stub.decisionBodies.push(await readJson(req));
      if (stub.jev.mode === "fail500") return json(res, 500, error(500, "stub jev failure"));
      if (stub.jev.mode === "malformed") return json(res, 200, { id: "gen-dec-stub", answers: { task: { type: "choice", choice: "banana" } } });
      if (stub.jev.mode === "slow") await sleep(1500);
      return json(res, 200, decision(stub.jev));
    }

    if (req.method === "POST" && path === "/api/v1/chat/completions") {
      const body = await readJson(req);
      stub.chatBodies.push(body);
      const deny = (body.provider as { data_collection?: string } | undefined)?.data_collection === "deny";
      switch (stub.chatModes[String(body.model)] ?? "ok") {
        case "account429":
          return json(res, 429, error(429, "Rate limit exceeded: free-models-per-min. ", { error_type: "rate_limit_exceeded" }));
        case "account429day":
          return json(res, 429, error(429, "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", { error_type: "rate_limit_exceeded" }));
        case "provider429":
          return json(res, 429, error(429, "Provider returned error", { error_type: "rate_limit_exceeded", provider_name: "StubCloud", raw: "temporarily rate-limited upstream" }));
        case "policy404":
          if (deny) return json(res, 404, error(404, "No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy"));
          break;
        case "policy503":
          if (deny) return json(res, 503, error(503, "There is no available model provider that meets your routing requirements"));
          break;
        case "unauthorized":
          return json(res, 401, error(401, "User not found."));
        case "server500":
          return json(res, 500, error(500, "Internal Server Error"));
        case "badrequest":
          return json(res, 400, error(400, "Invalid tool schema"));
        case "slow":
          await sleep(1500);
          break;
        case "notjson":
          res.writeHead(200, { "content-type": "application/json" });
          res.end("<html>oops</html>");
          return;
        default:
          break;
      }
      return json(res, 200, completion(body));
    }
    json(res, 404, error(404, `stub: no route ${req.method} ${path}`));
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

if (import.meta.main ?? process.argv[1]?.endsWith("stub-openrouter.ts")) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "5003" }, host: { type: "string", default: "127.0.0.1" } } });
  const stub = await startStubOpenRouter(Number(values.port), values.host);
  console.log(`[stub-openrouter] ${stub.url}  (synthetic; ${stub.models.length} models listed)`);
}
```

In the root `package.json`, add to `"scripts"` after `"stub-presidio"`:

```json
    "stub-openrouter": "node scripts/stub-openrouter.ts",
```

- [ ] **Step 2: Write the failing test**

Create `services/gateway/test/openrouter.test.ts`:

```ts
/**
 * OpenRouter request shaping, failure categories (spec section 7) and one
 * model attempt against the stub OpenRouter.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubOpenRouter, STUB_MODELS, type StubOpenRouter } from "../../../scripts/stub-openrouter.ts";
import { attemptChat } from "../src/dispatch.ts";
import { categorize, REQUEST_FAULTS, shapeBody } from "../src/openrouter.ts";
import { Pool } from "../src/pool.ts";
import { openRouterDeployments, parseFreeModels } from "../src/routing/freepool.ts";

describe("shapeBody", () => {
  it("keeps only the allowlisted fields, the messages and max_tokens", () => {
    const request = {
      messages: "ignored", tools: [1], temperature: 0.2, stop: ["x"], stream: true, model: "x",
      provider: { data_collection: "allow" }, models: ["a"], route: "fallback", transforms: [], plugins: [],
      user: "jane.roe@example.com", metadata: { who: "Jane Roe" }, prediction: { type: "content", content: "Jane Roe" },
    };
    const body = shapeBody(request, [{ role: "user", content: "hi" }], 1024);
    assert.deepEqual(body, { messages: [{ role: "user", content: "hi" }], max_tokens: 1024, tools: [1], temperature: 0.2, stop: ["x"] });
  });
});

describe("categorize", () => {
  const err = (message: string, metadata: Record<string, unknown> = {}) => JSON.stringify({ error: { code: 0, message, metadata } });
  const cases: [string, number, string, "allow" | "deny", Record<string, string>][] = [
    ["2xx", 200, "{}", "allow", { outcome: "ok" }],
    ["account, per minute", 429, err("Rate limit exceeded: free-models-per-min."), "allow", { outcome: "rate_limited_account", accountScope: "minute" }],
    ["account, per day", 429, err("Rate limit exceeded: free-models-per-day. Add 10 credits"), "allow", { outcome: "rate_limited_account", accountScope: "day" }],
    ["account, unnamed", 429, err("Rate limit exceeded"), "allow", { outcome: "rate_limited_account", accountScope: "minute" }],
    ["provider", 429, err("Provider returned error", { provider_name: "StubCloud" }), "allow", { outcome: "rate_limited_provider" }],
    ["data policy 404", 404, err("No endpoints found matching your data policy"), "deny", { outcome: "data_policy_unavailable" }],
    ["routing requirements 503", 503, err("There is no available model provider that meets your routing requirements"), "deny", { outcome: "data_policy_unavailable" }],
    ["data policy text on an allow request", 404, err("No endpoints found matching your data policy"), "allow", { outcome: "upstream_error" }],
    ["key 401", 401, err("No auth credentials found"), "allow", { outcome: "key_rejected" }],
    ["key 403", 403, err("Key disabled"), "allow", { outcome: "key_rejected" }],
    ["moderation 403", 403, err("flagged", { reasons: ["x"], flagged_input: "..." }), "allow", { outcome: "upstream_error" }],
    ["server error", 500, "not json", "allow", { outcome: "upstream_error" }],
    ["bad request", 400, err("Invalid tool schema"), "allow", { outcome: "upstream_error" }],
  ];
  for (const [name, status, text, dataCollection, want] of cases) {
    it(name, () => assert.deepEqual(categorize(status, text, dataCollection), want));
  }

  it("counts 400, 413 and 422 as the request's own fault", () => {
    assert.deepEqual([...REQUEST_FAULTS].sort(), [400, 413, 422]);
  });
});

describe("attemptChat against the stub OpenRouter", () => {
  const MODEL = "stub/alpha-70b:free";
  const body = { messages: [{ role: "user", content: "hello" }], max_tokens: 64 };
  let or: StubOpenRouter;
  let pool: Pool;
  before(async () => {
    or = await startStubOpenRouter();
  });
  after(() => or.close());
  beforeEach(() => {
    or.chatModes = {};
    or.chatBodies.length = 0;
    pool = new Pool({ healthIntervalMs: 0, healthTimeoutMs: 1000, unhealthyAfter: 2, cooldownMs: 60_000, env: { OR_TEST_KEY: "sk-or-test" } });
    pool.setModels(openRouterDeployments(parseFreeModels({ data: STUB_MODELS }), or.url, "OR_TEST_KEY"));
  });
  const attempt = (dataCollection: "allow" | "deny" = "allow", timeoutMs = 2000) =>
    attemptChat(MODEL, body, dataCollection, pool, timeoutMs, new AbortController().signal);

  it("sends the masked body with the model id, stream false, the data policy and the key", async () => {
    const r = await attempt("deny");
    assert.equal(r.attempt.outcome, "ok");
    assert.equal(r.attempt.status, 200);
    assert.equal((r.completion!.choices as unknown[]).length, 1);
    const sent = or.chatBodies[0];
    assert.deepEqual([sent.model, sent.stream, sent.provider, sent.max_tokens], [MODEL, false, { data_collection: "deny" }, 64]);
    assert.equal(or.authorizations.at(-1), "Bearer sk-or-test");
  });

  it("cools a model down after a provider 429", async () => {
    or.chatModes[MODEL] = "provider429";
    assert.equal((await attempt()).attempt.outcome, "rate_limited_provider");
    assert.equal(pool.isCoolingDown(MODEL), true);
  });

  it("cools a model down after a 5xx", async () => {
    or.chatModes[MODEL] = "server500";
    const r = await attempt();
    assert.deepEqual([r.attempt.outcome, r.attempt.status], ["upstream_error", 500]);
    assert.equal(pool.isCoolingDown(MODEL), true);
  });

  it("does not cool a model down for a request it rejected (400)", async () => {
    or.chatModes[MODEL] = "badrequest";
    const r = await attempt();
    assert.deepEqual([r.attempt.outcome, r.attempt.status], ["upstream_error", 400]);
    assert.equal(pool.isCoolingDown(MODEL), false);
  });

  it("reports an account limit with its scope and leaves the model alone", async () => {
    or.chatModes[MODEL] = "account429day";
    const r = await attempt();
    assert.deepEqual([r.attempt.outcome, r.accountScope], ["rate_limited_account", "day"]);
    assert.equal(pool.isCoolingDown(MODEL), false);
  });

  it("reports a data-policy refusal on a deny request only", async () => {
    or.chatModes[MODEL] = "policy404";
    assert.equal((await attempt("deny")).attempt.outcome, "data_policy_unavailable");
    assert.equal((await attempt("allow")).attempt.outcome, "ok");
    assert.equal(pool.isCoolingDown(MODEL), false);
  });

  it("reports a rejected key without cooling the model down", async () => {
    or.chatModes[MODEL] = "unauthorized";
    assert.equal((await attempt()).attempt.outcome, "key_rejected");
    assert.equal(pool.isCoolingDown(MODEL), false);
  });

  it("treats a 2xx that is not a chat completion as an upstream error", async () => {
    or.chatModes[MODEL] = "notjson";
    const r = await attempt();
    assert.deepEqual([r.attempt.outcome, r.completion], ["upstream_error", undefined]);
    assert.equal(pool.isCoolingDown(MODEL), true);
  });

  it("times out a slow model", async () => {
    or.chatModes[MODEL] = "slow";
    assert.equal((await attempt("allow", 200)).attempt.outcome, "timeout");
  });

  it("reports no_deployment for a model the pool does not know", async () => {
    const r = await attemptChat("stub/unknown:free", body, "allow", pool, 1000, new AbortController().signal);
    assert.deepEqual(r.attempt, { model: "stub/unknown:free", outcome: "no_deployment", ms: 0 });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test services/gateway/test/openrouter.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/openrouter.ts`.

- [ ] **Step 4: Write the request shaping and the categories**

Create `services/gateway/src/openrouter.ts`:

```ts
/**
 * OpenRouter requests and failures (spec section 7). shapeBody decides what
 * leaves the gateway; categorize sorts an upstream answer into an outcome.
 * Upstream bodies are read here and never stored.
 */
export type DataCollection = "allow" | "deny";
export type Outcome =
  | "ok"
  | "rate_limited_account"
  | "rate_limited_provider"
  | "data_policy_unavailable"
  | "key_rejected"
  | "upstream_error"
  | "timeout"
  | "network_error"
  | "client_abort"
  | "no_deployment";

/**
 * Request fields a client may set that reach the model. Everything else,
 * including provider, models, route, transforms, plugins, user and metadata,
 * is dropped: a client can't override the data policy, pass an identifier,
 * or slip unscanned text (such as `prediction`) past the scanner.
 */
export const PASSTHROUGH = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed",
  "stop",
] as const;

/** The upstream body before the per-attempt model, stream and provider fields. */
export function shapeBody(request: Readonly<Record<string, unknown>>, messages: readonly unknown[], maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = { messages, max_tokens: maxTokens };
  for (const field of PASSTHROUGH) if (request[field] !== undefined) body[field] = request[field];
  return body;
}

/** Upstream statuses that mean the request itself was refused; the caller gets them back. */
export const REQUEST_FAULTS: ReadonlySet<number> = new Set([400, 413, 422]);

export type Categorized = { outcome: Outcome; accountScope?: "minute" | "day" };

function errorOf(text: string): { message: string; providerName: string | undefined; moderation: boolean } {
  try {
    const e = (JSON.parse(text) as { error?: { message?: unknown; metadata?: Record<string, unknown> } } | null)?.error;
    const meta = e?.metadata ?? {};
    return {
      message: typeof e?.message === "string" ? e.message : "",
      providerName: typeof meta.provider_name === "string" ? meta.provider_name : undefined,
      moderation: "reasons" in meta || "flagged_input" in meta,
    };
  } catch {
    return { message: "", providerName: undefined, moderation: false };
  }
}

export function categorize(status: number, text: string, dataCollection: DataCollection): Categorized {
  if (status >= 200 && status < 300) return { outcome: "ok" };
  const { message, providerName, moderation } = errorOf(text);
  if (status === 401 || (status === 403 && !moderation)) return { outcome: "key_rejected" };
  if (status === 429) {
    if (/free-models-per-day/i.test(message)) return { outcome: "rate_limited_account", accountScope: "day" };
    // A 429 without a provider name is OpenRouter's own limit on this key.
    if (/free-models-per-min/i.test(message) || providerName === undefined) return { outcome: "rate_limited_account", accountScope: "minute" };
    return { outcome: "rate_limited_provider" };
  }
  if ((status === 404 || status === 503) && dataCollection === "deny" && /data policy|data_collection|routing requirements/i.test(message)) {
    return { outcome: "data_policy_unavailable" };
  }
  return { outcome: "upstream_error" };
}
```

- [ ] **Step 5: Add one model attempt to the dispatcher**

In `services/gateway/src/dispatch.ts`, add this import below the existing imports:

```ts
import { categorize, type DataCollection, type Outcome } from "./openrouter.ts";
```

and change the pool import to `import type { HealthEffect, Pool } from "./pool.ts";` if Task C1 has not already done so. Then append at the end of the file:

```ts
/** One try of one model, as the ledger records it (never an error body). */
export type ModelAttempt = { model: string; outcome: Outcome; status?: number; ms: number };
export type AttemptResult = { attempt: ModelAttempt; completion?: Record<string, unknown>; accountScope?: "minute" | "day" };

/** What an outcome says about the deployment's health (spec section 7 and plan refinement 4). */
function healthEffect(outcome: Outcome, status: number | undefined): HealthEffect {
  if (outcome === "ok") return "ok";
  if (outcome === "rate_limited_provider") return "cooldown";
  if (outcome === "upstream_error") return status === undefined || status >= 500 || status === 408 || (status >= 200 && status < 300) ? "cooldown" : "neutral";
  if (outcome === "timeout" || outcome === "network_error") return "fail";
  return "neutral"; // account limits, a rejected key, the data policy, a client abort: not this model's health
}

/** A 2xx body counts only when it is a chat completion with at least one choice. */
function parseCompletion(text: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(text) as unknown;
    const choices = (j as { choices?: unknown } | null)?.choices;
    if (typeof j === "object" && j !== null && !Array.isArray(j) && Array.isArray(choices) && choices.length > 0) return j as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * One attempt: send the masked body to one model's deployment with the data
 * policy, wait for the whole answer (upstream calls are never streamed), and
 * sort the result into an outcome. Health is updated here; the quota and the
 * deny-unavailable cache belong to the caller.
 */
export async function attemptChat(
  model: string,
  body: Record<string, unknown>,
  dataCollection: DataCollection,
  pool: Pool,
  timeoutMs: number,
  clientSignal: AbortSignal,
): Promise<AttemptResult> {
  const lease = pool.acquire(model);
  if (!lease) return { attempt: { model, outcome: "no_deployment", ms: 0 } };
  const { deployment, release } = lease;
  const started = performance.now();
  const finish = (outcome: Outcome, status?: number, extra: Partial<AttemptResult> = {}): AttemptResult => {
    release(healthEffect(outcome, status), status === undefined ? outcome : `${outcome} (HTTP ${status})`);
    const attempt: ModelAttempt = { model, outcome, ...(status === undefined ? {} : { status }), ms: Math.round(performance.now() - started) };
    return { attempt, ...extra };
  };

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const key = pool.apiKeyFor(deployment);
  if (key) headers.authorization = `Bearer ${key}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${deployment.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: deployment.servedModel, stream: false, provider: { data_collection: dataCollection } }),
      signal: AbortSignal.any([clientSignal, timeout]),
    });
    status = res.status;
    text = await res.text();
  } catch {
    if (clientSignal.aborted) return finish("client_abort");
    return finish(timeout.aborted ? "timeout" : "network_error");
  }

  const { outcome, accountScope } = categorize(status, text, dataCollection);
  if (outcome !== "ok") return finish(outcome, status, accountScope ? { accountScope } : {});
  const completion = parseCompletion(text);
  if (!completion) return finish("upstream_error", status);
  return finish("ok", status, { completion });
}
```

A 2xx that is not a chat completion is recorded as `upstream_error` with status 200; `healthEffect` cools that model down.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test services/gateway/test/openrouter.test.ts` then `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add scripts/stub-openrouter.ts services/gateway/src/openrouter.ts services/gateway/src/dispatch.ts services/gateway/test/openrouter.test.ts package.json
git commit -m "feat(openrouter): stub OpenRouter, request allowlist, failure categories and one model attempt" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C6: Free-model quota and capacity

**Files:**
- Create: `services/gateway/src/routing/quota.ts`
- Test: `services/gateway/test/quota.test.ts`

**Interfaces:**
- Consumes: `startStubOpenRouter` (C5) for the key endpoint.
- Produces: `type Capacity = { chatAvailable: boolean; reason?: "no_models" | "key_rejected" | "daily_exhausted" | "rate_limited"; retryAfterSec?: number }`; `type QuotaOptions = { rpm: number; keyIntervalMs: number; keyUrl?: string; apiKey?: string; now?: () => number }`; `class Quota { take(): boolean; capacity(modelsReady: boolean): Capacity; onAccountLimit(scope: "minute" | "day"): void; onKeyRejected(): void; refresh(): Promise<void>; start(): void; stop(): void }`.

Spec section 7, "Quota": at most `rpm` free-model calls in any 60-second window, and every attempt counts. The daily remaining count is read from `GET /api/v1/key` (`free_model_daily_requests.remaining`, V2) at start-up, every 10 minutes and after any 429, and counted down locally between reads. `capacity()` reports chat unavailable when the pool is empty, the daily remaining is 0, OpenRouter rejected the key, or the minute window is full (then with `retryAfterSec`). A per-minute account 429 pauses free-model calls for 60 s; a per-day one pauses them until a key read shows capacity again. `onKeyRejected` starts a key read at once (plan refinement 5); without a key reader (catalog mode) it does nothing.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/quota.test.ts`:

```ts
/**
 * Free-model quota (spec section 7): the minute window, the daily allowance,
 * pauses after account limits, a rejected key, and capacity().
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubOpenRouter, type StubOpenRouter } from "../../../scripts/stub-openrouter.ts";
import { Quota } from "../src/routing/quota.ts";

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("Quota", () => {
  let or: StubOpenRouter;
  before(async () => {
    or = await startStubOpenRouter();
  });
  after(() => or.close());
  beforeEach(() => {
    or.key = { status: 200, remaining: 1000 };
  });
  const withKey = (c: ReturnType<typeof clock>) => new Quota({ rpm: 1000, keyIntervalMs: 0, keyUrl: `${or.url}/api/v1/key`, apiKey: "sk-or-test", now: c.now });

  it("allows rpm calls in any 60-second window", () => {
    const c = clock();
    const q = new Quota({ rpm: 3, keyIntervalMs: 0, now: c.now });
    assert.deepEqual([q.take(), q.take(), q.take(), q.take()], [true, true, true, false]);
    assert.deepEqual(q.capacity(true), { chatAvailable: false, reason: "rate_limited", retryAfterSec: 60 });
    c.advance(30_000);
    assert.equal(q.capacity(true).retryAfterSec, 30);
    c.advance(30_000);
    assert.equal(q.take(), true);
  });

  it("pauses for 60 seconds after an account per-minute limit", () => {
    const c = clock();
    const q = new Quota({ rpm: 20, keyIntervalMs: 0, now: c.now });
    q.onAccountLimit("minute");
    assert.equal(q.take(), false);
    assert.deepEqual(q.capacity(true), { chatAvailable: false, reason: "rate_limited", retryAfterSec: 60 });
    c.advance(60_001);
    assert.equal(q.take(), true);
  });

  it("counts the daily allowance down between key reads", async () => {
    or.key.remaining = 2;
    const q = withKey(clock());
    await q.refresh();
    assert.deepEqual([q.take(), q.take(), q.take()], [true, true, false]);
    assert.deepEqual(q.capacity(true), { chatAvailable: false, reason: "daily_exhausted" });
    or.key.remaining = 5;
    await q.refresh();
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("after an account per-day limit, waits for a key read that shows allowance", async () => {
    or.key.remaining = 0;
    const q = withKey(clock());
    q.onAccountLimit("day");
    await q.refresh();
    assert.equal(q.capacity(true).reason, "daily_exhausted");
    or.key.remaining = 900;
    await q.refresh();
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("a rejected key makes chat unavailable until a key read succeeds", async () => {
    or.key.status = 401;
    const q = withKey(clock());
    await q.refresh();
    assert.deepEqual(q.capacity(true), { chatAvailable: false, reason: "key_rejected" });
    or.key.status = 200;
    await q.refresh();
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("onKeyRejected blocks at once and starts a key read", async () => {
    const q = withKey(clock());
    const reads = or.keyReads;
    q.onKeyRejected();
    assert.equal(q.capacity(true).reason, "key_rejected");
    await q.refresh(); // the key is fine, so chat comes back
    assert.ok(or.keyReads > reads);
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("without a key reader (catalog mode) a rejected key does not latch", () => {
    const q = new Quota({ rpm: 20, keyIntervalMs: 0 });
    q.onKeyRejected();
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("reports no models before the pool is ready", () => {
    assert.deepEqual(new Quota({ rpm: 20, keyIntervalMs: 0 }).capacity(false), { chatAvailable: false, reason: "no_models" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/quota.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/routing/quota.ts`.

- [ ] **Step 3: Write the implementation**

Create `services/gateway/src/routing/quota.ts`:

```ts
/**
 * Free-model quota (spec section 7): at most `rpm` free-model calls in any
 * 60-second window (every attempt counts), the key's daily allowance read
 * from OpenRouter and counted down locally between reads, and pauses after
 * an account-level 429. capacity() is what the paywall asks before it shows
 * a price for chat.
 */
export type Capacity = { chatAvailable: boolean; reason?: "no_models" | "key_rejected" | "daily_exhausted" | "rate_limited"; retryAfterSec?: number };
export type QuotaOptions = { rpm: number; keyIntervalMs: number; keyUrl?: string; apiKey?: string; now?: () => number };

const WINDOW_MS = 60_000;

export class Quota {
  private readonly opts: QuotaOptions;
  private readonly calls: number[] = [];
  private pausedUntil = 0;
  private dailyRemaining: number | undefined;
  private dailyPaused = false;
  private keyRejected = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: QuotaOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Why no free-model call may start now, or undefined when one may. */
  private blocked(now: number): Capacity["reason"] {
    if (this.keyRejected) return "key_rejected";
    if (this.dailyPaused || this.dailyRemaining === 0) return "daily_exhausted";
    while (this.calls.length > 0 && this.calls[0] <= now - WINDOW_MS) this.calls.shift();
    if (this.pausedUntil > now || this.calls.length >= this.opts.rpm) return "rate_limited";
    return undefined;
  }

  /** Count one free-model call; false when the window, the daily allowance or a pause forbids it. */
  take(): boolean {
    const now = this.now();
    if (this.blocked(now)) return false;
    this.calls.push(now);
    if (this.dailyRemaining !== undefined) this.dailyRemaining = Math.max(0, this.dailyRemaining - 1);
    return true;
  }

  capacity(modelsReady: boolean): Capacity {
    if (!modelsReady) return { chatAvailable: false, reason: "no_models" };
    const now = this.now();
    const reason = this.blocked(now);
    if (reason === undefined) return { chatAvailable: true };
    if (reason !== "rate_limited") return { chatAvailable: false, reason };
    const windowFrees = this.calls.length >= this.opts.rpm ? this.calls[this.calls.length - this.opts.rpm] + WINDOW_MS : 0;
    const until = Math.max(this.pausedUntil, windowFrees);
    return { chatAvailable: false, reason, retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)) };
  }

  /** An account-level 429: pause for 60 s (per minute) or until a key read shows allowance (per day). */
  onAccountLimit(scope: "minute" | "day"): void {
    if (scope === "minute") this.pausedUntil = this.now() + WINDOW_MS;
    else {
      this.dailyPaused = true;
      this.dailyRemaining = 0;
    }
    void this.refresh();
  }

  /** OpenRouter rejected the key: unavailable until a key read succeeds, and one starts now. */
  onKeyRejected(): void {
    if (!this.opts.keyUrl) return;
    this.keyRejected = true;
    void this.refresh();
  }

  /** Read the key's free-model allowance (GET /api/v1/key). Failures keep the last known values. */
  async refresh(): Promise<void> {
    if (!this.opts.keyUrl || !this.opts.apiKey) return;
    let res: Response;
    try {
      res = await fetch(this.opts.keyUrl, { headers: { authorization: `Bearer ${this.opts.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    } catch {
      return;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      this.keyRejected = true;
      return;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return;
    }
    this.keyRejected = false;
    const data = (body as { data?: unknown } | null)?.data ?? body;
    const remaining = (data as { free_model_daily_requests?: { remaining?: unknown } } | null)?.free_model_daily_requests?.remaining;
    if (typeof remaining === "number" && Number.isInteger(remaining) && remaining >= 0) {
      this.dailyRemaining = remaining;
      if (remaining > 0) this.dailyPaused = false;
    }
  }

  start(): void {
    if (this.timer || this.opts.keyIntervalMs <= 0 || !this.opts.keyUrl) return;
    this.timer = setInterval(() => void this.refresh(), this.opts.keyIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test services/gateway/test/quota.test.ts`
Expected: PASS, 8 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/routing/quota.ts services/gateway/test/quota.test.ts
git commit -m "feat(routing): free-model quota, daily allowance and chat capacity" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C7: Jev, the rules fallback, and the live OpenRouter checks

**Files:**
- Create: `services/gateway/src/routing/jev.ts`
- Create: `services/gateway/src/routing/classify.ts`
- Create: `scripts/verify-openrouter.ts`
- Test: `services/gateway/test/jev.test.ts`
- Modify: `package.json` (root: `verify:openrouter` script)

**Interfaces:**
- Consumes: `TASKS`, `Task` (C3); `categorize` (C5); `parseFreeModels` (C2); `classifyByRules`, `DEFAULT_ROUTING_CONFIG`, `inferToolRequirement` from `packages/route-engine/dist/index.js`; `startStubOpenRouter` (C5).
- Produces:
  - `jev.ts`: `JEV_QUESTIONS` (the spec's three questions, exactly); `type JevState = { request: string; has_tools: boolean; prompt_tokens: number }`; `type JevProbabilities = { task: Record<string, number>; difficulty: Record<string, number>; health: number }`; `type JevAnswer = { task: Task; difficulty: number; health: number; probabilities: JevProbabilities }`; `type JevResult = JevAnswer & { latencyMs: number }`; `class JevClient { constructor(opts: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }); classify(state: JevState): Promise<JevResult | undefined> }`; `parseJevAnswers(body: unknown): JevAnswer | undefined`.
  - `classify.ts`: `type TaskInput = { system: string; turns: { role: string; text: string }[]; lastUser: string; hasTools: boolean; toolChoice: unknown; promptTokens: number }`; `type TaskClass = { classifier: "jev" | "rules"; task: Task; difficulty: number; health: number | null; jev: { probabilities: JevProbabilities; latencyMs: number } | null }`; `classifyWithRules(input: TaskInput): TaskClass`; `jevState(input: TaskInput): JevState`; `classifyTask(input: TaskInput, jev: JevClient | undefined, phi: boolean): Promise<TaskClass>`.

Spec section 6, "Classification with Jev" and "Rules fallback". Jev reads the masked system prompt (first 1,000 characters) and the last three messages of any role (up to 7,000 characters). Task = the most probable label; difficulty = the index of the most probable criterion plus one; health = the `noul` probability. A timeout, a non-2xx status or an unexpected shape sends the request to the rules. Jev is never called for PHI (D9). Rules: tier from `classifyByRules` with `DEFAULT_ROUTING_CONFIG.scoring`; SIMPLE 1, MEDIUM 3, COMPLEX 4, REASONING 5, ambiguous 3. Task: `tool_use` when tools are attached and `inferToolRequirement` is true; else `long_document` above 8,000 estimated tokens; else `code` when `codePresence` scored above 0; else `reasoning` for the REASONING tier; else `chat`.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/test/jev.test.ts`:

```ts
/**
 * Jev through the Decisions API, and the rules fallback (spec section 6).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubOpenRouter, type StubOpenRouter } from "../../../scripts/stub-openrouter.ts";
import { classifyTask, classifyWithRules, jevState, type TaskInput } from "../src/routing/classify.ts";
import { JEV_QUESTIONS, JevClient, parseJevAnswers } from "../src/routing/jev.ts";

describe("parseJevAnswers", () => {
  const answers = (over: Record<string, unknown> = {}) => ({
    answers: {
      task: { type: "choice", choice: "code", probabilities: { code: 0.8, chat: 0.2 }, confidence: 0.7 },
      difficulty: { type: "score", score: 2.1, probabilities: { "0": 0.05, "1": 0.1, "2": 0.6, "3": 0.2, "4": 0.05 } },
      health: { type: "noul", noul: 0.02 },
      ...over,
    },
  });

  it("reads the choice, the most likely difficulty (index + 1) and the health probability", () => {
    assert.deepEqual(parseJevAnswers(answers()), {
      task: "code",
      difficulty: 3,
      health: 0.02,
      probabilities: { task: { code: 0.8, chat: 0.2 }, difficulty: { "0": 0.05, "1": 0.1, "2": 0.6, "3": 0.2, "4": 0.05 }, health: 0.02 },
    });
  });

  it("uses the rounded score when a score answer has no probabilities", () => {
    assert.equal(parseJevAnswers(answers({ difficulty: { type: "score", score: 3.6 } }))?.difficulty, 5);
  });

  it("accepts difficulty probabilities keyed by criterion name", () => {
    assert.equal(parseJevAnswers(answers({ difficulty: { type: "score", probabilities: { trivial: 0.1, hard: 0.9 } } }))?.difficulty, 4);
  });

  it("rejects an unknown task, a missing health answer and an out-of-range difficulty", () => {
    assert.equal(parseJevAnswers(answers({ task: { type: "choice", choice: "poetry" } })), undefined);
    assert.equal(parseJevAnswers(answers({ health: undefined })), undefined);
    assert.equal(parseJevAnswers(answers({ difficulty: { type: "score", score: 7 } })), undefined);
    assert.equal(parseJevAnswers({}), undefined);
  });
});

const input = (lastUser: string, extra: Partial<TaskInput> = {}): TaskInput => ({
  system: "",
  turns: [{ role: "user", text: lastUser }],
  lastUser,
  hasTools: false,
  toolChoice: undefined,
  promptTokens: Math.ceil(lastUser.length / 4),
  ...extra,
});
const pick = (t: { task: string; difficulty: number }) => ({ task: t.task, difficulty: t.difficulty });

describe("rules fallback", () => {
  it("a simple question is chat at difficulty 1", () => {
    assert.deepEqual(pick(classifyWithRules(input("What is the capital of France?"))), { task: "chat", difficulty: 1 });
  });
  it("a proof is reasoning at difficulty 5", () => {
    assert.deepEqual(pick(classifyWithRules(input("Prove that the sum of two odd integers is even, step by step."))), { task: "reasoning", difficulty: 5 });
  });
  it("code keywords make a code task; an ambiguous tier is difficulty 3", () => {
    assert.deepEqual(pick(classifyWithRules(input("Write a python function that parses a CSV file"))), { task: "code", difficulty: 3 });
  });
  it("attached tools and an action make tool_use", () => {
    assert.equal(classifyWithRules(input("Cancel order B-42 and book the 9am flight to SFO.", { hasTools: true })).task, "tool_use");
  });
  it("a long paste is long_document", () => {
    assert.equal(classifyWithRules(input("lorem ipsum ".repeat(3000))).task, "long_document");
  });
  it("has no health flag and no Jev data", () => {
    const t = classifyWithRules(input("hi"));
    assert.deepEqual([t.classifier, t.health, t.jev], ["rules", null, null]);
  });
});

describe("jevState", () => {
  it("sends the first 1,000 characters of the system prompt and the last three turns", () => {
    const s = jevState({ system: "S".repeat(1500), turns: [1, 2, 3, 4].map((n) => ({ role: "user", text: `turn ${n}` })), lastUser: "turn 4", hasTools: true, toolChoice: undefined, promptTokens: 99 });
    assert.ok(s.request.startsWith(`[system]\n${"S".repeat(1000)}\n\n`));
    assert.ok(!s.request.includes("turn 1") && s.request.includes("turn 2") && s.request.endsWith("turn 4"));
    assert.deepEqual([s.has_tools, s.prompt_tokens], [true, 99]);
  });
  it("keeps at most the last 7,000 characters of the turns", () => {
    const s = jevState({ system: "", turns: [{ role: "user", text: "x".repeat(9000) }], lastUser: "x", hasTools: false, toolChoice: undefined, promptTokens: 1 });
    assert.equal(s.request.length, 7000);
  });
});

describe("Jev against the stub", () => {
  let or: StubOpenRouter;
  before(async () => {
    or = await startStubOpenRouter();
  });
  after(() => or.close());
  beforeEach(() => {
    or.jev = { mode: "ok", task: "reasoning", difficulty: 4, health: 0.7 };
    or.decisionBodies.length = 0;
  });
  const client = (timeoutMs = 1000) => new JevClient({ baseUrl: or.url, apiKey: "sk-or-test", model: "typesafe/jev-1.13", timeoutMs });
  const state = { request: "[user]\nHow often should <PERSON_1> use the inhaler?", has_tools: false, prompt_tokens: 12 };

  it("sends the model, the state and the spec's three questions with the key", async () => {
    const r = await client().classify(state);
    assert.deepEqual([r?.task, r?.difficulty, r?.health], ["reasoning", 4, 0.7]);
    assert.equal(typeof r?.latencyMs, "number");
    assert.deepEqual(or.decisionBodies[0], { model: "typesafe/jev-1.13", state, questions: JSON.parse(JSON.stringify(JEV_QUESTIONS)) });
    assert.equal(or.authorizations.at(-1), "Bearer sk-or-test");
  });

  for (const mode of ["slow", "fail500", "malformed"] as const) {
    it(`returns undefined when Jev is ${mode}`, async () => {
      or.jev.mode = mode;
      assert.equal(await client(300).classify(state), undefined);
    });
  }

  it("classifyTask uses Jev unless the request is PHI, and falls back to the rules on failure", async () => {
    const jev = client();
    const a = await classifyTask(input("Draft a note to <PERSON_1>."), jev, false);
    assert.deepEqual([a.classifier, a.task, a.difficulty, a.health], ["jev", "reasoning", 4, 0.7]);
    const before = or.decisionBodies.length;
    const b = await classifyTask(input("Refill for <PERSON_1>"), jev, true);
    assert.equal(b.classifier, "rules");
    assert.equal(or.decisionBodies.length, before, "Jev never sees PHI");
    or.jev.mode = "fail500";
    assert.equal((await classifyTask(input("hi"), jev, false)).classifier, "rules");
    assert.equal((await classifyTask(input("hi"), undefined, false)).classifier, "rules");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/jev.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/routing/classify.ts`.

- [ ] **Step 3: Write the Jev client**

Create `services/gateway/src/routing/jev.ts`:

```ts
/**
 * Jev (typesafe/jev-1.13) through OpenRouter's Decisions API (spec section
 * 6): task, difficulty and whether the request is about a specific person's
 * health, answered as probabilities in about half a second. Jev only reads
 * masked text of requests that are not PHI. The API is alpha, so parsing is
 * strict: any failure returns undefined and the caller uses the rules.
 */
import { TASKS, type Task } from "./scores.ts";

const DIFFICULTY_CRITERIA = ["trivial", "easy", "moderate", "hard", "expert"];

export const JEV_QUESTIONS = {
  task: {
    type: "choice",
    instructions: "What kind of task is the last user message?",
    criteria: {
      chat: "conversation or a simple question",
      extraction: "pull fields or facts out of text",
      rewrite: "rewrite, translate or summarize given text",
      code: "write, fix or explain code",
      reasoning: "multi-step reasoning, math or planning",
      tool_use: "needs one of the provided tools to act",
      long_document: "work over a long pasted document",
    },
  },
  difficulty: {
    type: "score",
    instructions: "How hard is this request for a language model?",
    criteria: DIFFICULTY_CRITERIA,
  },
  health: {
    type: "noul",
    instructions: "Is this about the health, condition, treatment or medication of a specific person? The person may appear only as a placeholder such as <PERSON_1>.",
    criteria: {
      true: "about a specific person's health",
      false: "not about a specific person's health; general medical questions count as false",
    },
  },
};

export type JevState = { request: string; has_tools: boolean; prompt_tokens: number };
export type JevProbabilities = { task: Record<string, number>; difficulty: Record<string, number>; health: number };
export type JevAnswer = { task: Task; difficulty: number; health: number; probabilities: JevProbabilities };
export type JevResult = JevAnswer & { latencyMs: number };
export type JevOptions = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

export class JevClient {
  private readonly opts: JevOptions;

  constructor(opts: JevOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
  }

  /** One decision; undefined on a timeout, a non-2xx status or an unexpected shape. */
  async classify(state: JevState): Promise<JevResult | undefined> {
    const started = performance.now();
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/alpha/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ model: this.opts.model, state, questions: JEV_QUESTIONS }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return undefined;
      }
      const answer = parseJevAnswers(await res.json());
      return answer && { ...answer, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return undefined;
    }
  }
}

function probabilities(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([, p]) => typeof p === "number" && p >= 0 && p <= 1)) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

function mostLikely(p: Record<string, number>): string {
  return Object.entries(p).reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

type Answers = Partial<Record<"task" | "difficulty" | "health", Record<string, unknown> | undefined>>;

/** The three answers as the gateway uses them, or undefined when anything is missing or out of range. */
export function parseJevAnswers(body: unknown): JevAnswer | undefined {
  const answers = (body as { answers?: Answers } | null)?.answers;
  if (typeof answers !== "object" || answers === null) return undefined;

  const taskProbs = probabilities(answers.task?.probabilities);
  const choice = typeof answers.task?.choice === "string" ? answers.task.choice : taskProbs ? mostLikely(taskProbs) : undefined;
  if (choice === undefined || !(TASKS as readonly string[]).includes(choice)) return undefined;

  const difficultyProbs = probabilities(answers.difficulty?.probabilities);
  const score = answers.difficulty?.score;
  let index = Number.NaN;
  if (difficultyProbs) {
    const label = mostLikely(difficultyProbs);
    index = /^\d+$/.test(label) ? Number(label) : DIFFICULTY_CRITERIA.indexOf(label);
  } else if (typeof score === "number") index = Math.round(score);
  if (!Number.isInteger(index) || index < 0 || index > 4) return undefined;

  const health = answers.health?.noul;
  if (typeof health !== "number" || health < 0 || health > 1) return undefined;

  return { task: choice as Task, difficulty: index + 1, health, probabilities: { task: taskProbs ?? {}, difficulty: difficultyProbs ?? {}, health } };
}
```

- [ ] **Step 4: Write the task classification**

Create `services/gateway/src/routing/classify.ts`:

```ts
/**
 * Task classification for chat (spec section 6): Jev first, the route
 * engine's rules when Jev is off, fails, answers badly, or the request is
 * already PHI (D9: Jev never sees health data).
 */
import { classifyByRules, DEFAULT_ROUTING_CONFIG, inferToolRequirement } from "../../../../packages/route-engine/dist/index.js";
import type { JevClient, JevProbabilities, JevState } from "./jev.ts";
import type { Task } from "./scores.ts";

export type TaskInput = {
  /** Masked system and developer text. */
  system: string;
  /** Masked text of every other message, in order. */
  turns: { role: string; text: string }[];
  lastUser: string;
  hasTools: boolean;
  toolChoice: unknown;
  promptTokens: number;
};

export type TaskClass = {
  classifier: "jev" | "rules";
  task: Task;
  difficulty: number;
  health: number | null;
  jev: { probabilities: JevProbabilities; latencyMs: number } | null;
};

const TIER_DIFFICULTY: Record<string, number> = { SIMPLE: 1, MEDIUM: 3, COMPLEX: 4, REASONING: 5 };

/** The rules fallback: no network, no health flag. */
export function classifyWithRules(input: TaskInput): TaskClass {
  const system = input.system || undefined;
  const r = classifyByRules(input.lastUser, system, input.promptTokens, DEFAULT_ROUTING_CONFIG.scoring);
  const difficulty = r.tier ? TIER_DIFFICULTY[r.tier] : 3;
  const code = r.dimensions?.find((d: { name: string }) => d.name === "codePresence")?.score ?? 0;
  let task: Task = "chat";
  if (input.hasTools && inferToolRequirement(input.lastUser, system, input.toolChoice)) task = "tool_use";
  else if (input.promptTokens > 8000) task = "long_document";
  else if (code > 0) task = "code";
  else if (r.tier === "REASONING") task = "reasoning";
  return { classifier: "rules", task, difficulty, health: null, jev: null };
}

/** What Jev reads: the system prompt's first 1,000 characters and the last three turns, at most 7,000 characters. */
export function jevState(input: TaskInput): JevState {
  const turns = input.turns
    .slice(-3)
    .map((t) => `[${t.role}]\n${t.text}`)
    .join("\n\n");
  const recent = turns.length > 7000 ? turns.slice(-7000) : turns;
  const system = input.system ? `[system]\n${input.system.slice(0, 1000)}\n\n` : "";
  return { request: system + recent, has_tools: input.hasTools, prompt_tokens: input.promptTokens };
}

export async function classifyTask(input: TaskInput, jev: JevClient | undefined, phi: boolean): Promise<TaskClass> {
  if (jev && !phi) {
    const j = await jev.classify(jevState(input));
    if (j) return { classifier: "jev", task: j.task, difficulty: j.difficulty, health: j.health, jev: { probabilities: j.probabilities, latencyMs: j.latencyMs } };
  }
  return classifyWithRules(input);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test services/gateway/test/jev.test.ts`
Expected: PASS, 17 tests, 0 failures.

- [ ] **Step 6: Write the live OpenRouter check (V1, V2, V5)**

Create `scripts/verify-openrouter.ts`:

```ts
/**
 * Live checks against OpenRouter for the spec's verification items. Needs
 * OPENROUTER_API_KEY and sends only short synthetic text. Cost: one Jev
 * call, one key read, and one 16-token call per free model.
 *
 *   node scripts/verify-openrouter.ts [--base-url https://openrouter.ai]
 *
 * V1  one Decisions API call with the gateway's questions: the raw answers,
 *     and whether parseJevAnswers accepts them.
 * V2  GET /api/v1/key: free_model_daily_requests as OpenRouter reports it.
 * V5  one no-collection call (provider.data_collection: deny) per free model:
 *     the status and outcome, i.e. which free models can take health data now.
 */
import { parseArgs } from "node:util";
import { categorize } from "../services/gateway/src/openrouter.ts";
import { parseFreeModels } from "../services/gateway/src/routing/freepool.ts";
import { JEV_QUESTIONS, parseJevAnswers } from "../services/gateway/src/routing/jev.ts";

const { values } = parseArgs({ options: { "base-url": { type: "string", default: "https://openrouter.ai" } } });
const base = values["base-url"]!.replace(/\/+$/, "");
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("OPENROUTER_API_KEY is required");
  process.exit(2);
}
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const readJson = async (r: Response): Promise<any> => r.json().catch(() => undefined);

console.log("V1: Decisions API (Jev)");
const state = { request: "[user]\nWhat is the capital of France?", has_tools: false, prompt_tokens: 8 };
const decision = await fetch(`${base}/api/alpha/decisions`, { method: "POST", headers, body: JSON.stringify({ model: "typesafe/jev-1.13", state, questions: JEV_QUESTIONS }) });
const decisionBody = await readJson(decision);
console.log(`  HTTP ${decision.status} answers=${JSON.stringify(decisionBody?.answers ?? decisionBody)}`);
console.log(`  parseJevAnswers: ${JSON.stringify(parseJevAnswers(decisionBody) ?? "REJECTED")}`);

console.log("V2: key allowance");
const keyRes = await fetch(`${base}/api/v1/key`, { headers });
const keyBody = await readJson(keyRes);
console.log(`  HTTP ${keyRes.status} free_model_daily_requests=${JSON.stringify((keyBody?.data ?? keyBody)?.free_model_daily_requests)}`);

console.log("V5: one no-collection call per free model");
const models = parseFreeModels(await readJson(await fetch(`${base}/api/v1/models`)));
for (const m of models) {
  const body = { model: m.id, messages: [{ role: "user", content: "Say OK." }], max_tokens: 16, stream: false, provider: { data_collection: "deny" } };
  const r = await fetch(`${base}/api/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  const { outcome } = categorize(r.status, text, "deny");
  console.log(`  ${m.id.padEnd(56)} HTTP ${r.status} ${outcome}${r.ok ? "" : ` ${text.slice(0, 160)}`}`);
}
```

In the root `package.json`, add to `"scripts"` after `"verify:presidio"`:

```json
    "verify:openrouter": "node scripts/verify-openrouter.ts",
```

If `OPENROUTER_API_KEY` is set in your environment, run `npm run verify:openrouter` and put its output in the report: it confirms V1 (the answers parse), V2 (the allowance field) and V5 (which free models accept `data_collection: deny`). If the key is not set, write "V1/V2/V5 live check not run: no key" in the report. The owner runs it before chat launches.

- [ ] **Step 7: Commit**

```bash
git add services/gateway/src/routing/jev.ts services/gateway/src/routing/classify.ts services/gateway/test/jev.test.ts scripts/verify-openrouter.ts package.json
git commit -m "feat(routing): Jev through the Decisions API, rules fallback, live OpenRouter checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C8: Masking a whole conversation

**Files:**
- Modify: `services/gateway/src/privacy/mask.ts` (append the conversation walker)
- Modify: `services/gateway/test/privacy.test.ts` (append a suite)

**Interfaces:**
- Consumes: `Detected` (A1); `Masker` (A3); `restoreText` (A3); the test file's `detect()` helper and `KNOWN_VALUES` (A3).
- Produces (`mask.ts`): `type TextPart = { type: "text"; text: string }`; `type ToolCall = { id?: string; type: "function"; function: { name: string; arguments: string } }`; `type Message = { role: string; content?: string | TextPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string }`; `type TextMapper = (text: string, context: string) => string`; `mapConversation(messages: readonly Message[], fn: TextMapper): Message[]`; `withinValue(text: string, found: readonly Detected[], contextLength: number): Detected[]`.

Spec section 4, chat step 2: detect over every text field (string `content` and text parts of every role, and assistant `tool_calls[].function.arguments`); tool definitions are not scanned. Placeholders number in reading order. Plan refinements 1 and 3: messages keep only `role`, `content`, `tool_calls` and `tool_call_id`; JSON arguments are masked value by value, with the key as detection context, then re-serialized.

- [ ] **Step 1: Write the failing test**

In `services/gateway/test/privacy.test.ts`, change the mask import to `import { mapConversation, Masker, withinValue } from "../src/privacy/mask.ts";` and append at the end of the file:

```ts
describe("conversation masking", () => {
  it("visits every text field in reading order, with the JSON key as context", () => {
    const seen: [string, string][] = [];
    mapConversation(
      [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "open", arguments: '{"patient":"Jane Roe","ids":[991122],"note":{"mrn":"991122"}}' } }] },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ],
      (text, context) => {
        seen.push([context, text]);
        return text;
      },
    );
    assert.deepEqual(seen, [["", "Be brief."], ["", "part one"], ["", "part two"], ["patient: ", "Jane Roe"], ["ids: ", "991122"], ["mrn: ", "991122"], ["", "done"]]);
  });

  it("keeps only role, content, tool_calls and tool_call_id", () => {
    const [m] = mapConversation([{ role: "user", content: "hi", name: "jane_roe", reasoning: "secret" } as never], (t) => t);
    assert.deepEqual(m, { role: "user", content: "hi" });
  });

  it("re-serializes JSON arguments and scans other arguments whole", () => {
    const out = mapConversation(
      [
        {
          role: "assistant",
          tool_calls: [
            { type: "function", function: { name: "a", arguments: '{ "q" : "Tom Baker" }' } },
            { type: "function", function: { name: "b", arguments: "not json: Tom Baker" } },
          ],
        },
      ],
      (t) => t.replaceAll("Tom Baker", "<PERSON_1>"),
    );
    assert.deepEqual(out[0].tool_calls!.map((c) => c.function.arguments), ['{"q":"<PERSON_1>"}', "not json: <PERSON_1>"]);
  });

  it("keeps a number with nothing to mask, and turns a masked number into a string", () => {
    const out = mapConversation([{ role: "assistant", tool_calls: [{ type: "function", function: { name: "a", arguments: '{"n":42,"mrn":991122}' } }] }], (t) =>
      t.replaceAll("991122", "<MEDICAL_RECORD_1>"),
    );
    assert.equal(out[0].tool_calls![0].function.arguments, '{"n":42,"mrn":"<MEDICAL_RECORD_1>"}');
  });

  it("withinValue drops spans inside the context and moves the others onto the value", () => {
    // analysed text "mrn: 991122": "mrn" (0..3) is context only; 991122 is at 5..11
    const found = [
      { type: "PERSON", start: 0, end: 3, score: 0.9 },
      { type: "MEDICAL_RECORD", start: 5, end: 11, score: 0.45 },
    ];
    assert.deepEqual(withinValue("991122", found, 5), [{ type: "MEDICAL_RECORD", start: 0, end: 6, score: 0.45 }]);
    assert.deepEqual(withinValue("991122", [{ type: "PERSON", start: 3, end: 8, score: 0.9 }], 5), [{ type: "PERSON", start: 0, end: 3, score: 0.9 }]);
  });

  it("launch gate 2 for tool-call arguments: masking then restoring gives the same JSON", () => {
    const args = JSON.stringify({ patient: 'Jane "JR" Roe', file: "C:\\records\\991122.txt" });
    const masker = new Masker();
    const [m] = mapConversation([{ role: "assistant", tool_calls: [{ type: "function", function: { name: "open", arguments: args } }] }], (text, context) =>
      masker.mask(text, withinValue(text, detect(context + text), context.length)),
    );
    const masked = m.tool_calls![0].function.arguments;
    for (const { value } of KNOWN_VALUES) assert.ok(!masked.includes(value), `${value} leaked`);
    assert.equal(restoreText(masked, masker.map, { unresolved: 0 }, true), args);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test services/gateway/test/privacy.test.ts`
Expected: FAIL: `mapConversation` is not exported by `../src/privacy/mask.ts` (SyntaxError on the import).

- [ ] **Step 3: Write the conversation walker**

Append to `services/gateway/src/privacy/mask.ts`:

```ts
/** A chat message as the gateway forwards it: these fields only, and text content only. */
export type TextPart = { type: "text"; text: string };
export type ToolCall = { id?: string; type: "function"; function: { name: string; arguments: string } };
export type Message = { role: string; content?: string | TextPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string };

/** Receives each text and a context prefix that Presidio reads with it (a JSON key); returns the replacement text. */
export type TextMapper = (text: string, context: string) => string;

/**
 * Rebuild a conversation with every text field passed through fn, in reading
 * order: messages in order; in each, the content (a string or text parts),
 * then each tool call's arguments. Arguments that are JSON are split into
 * their string and number values (keys are the developer's schema and stay),
 * so a masked value can never break JSON escaping; a masked number comes
 * back as a string. Fields other than role, content, tool_calls and
 * tool_call_id are dropped, so no unscanned text can ride along.
 */
export function mapConversation(messages: readonly Message[], fn: TextMapper): Message[] {
  return messages.map((m) => {
    const out: Message = { role: m.role };
    if (typeof m.content === "string") out.content = fn(m.content, "");
    else if (Array.isArray(m.content)) out.content = m.content.map((p): TextPart => ({ type: "text", text: fn(p.text, "") }));
    else if (m.content === null) out.content = null;
    if (m.tool_calls) {
      out.tool_calls = m.tool_calls.map((c): ToolCall => ({
        ...(c.id === undefined ? {} : { id: c.id }),
        type: "function",
        function: { name: c.function.name, arguments: mapArguments(c.function.arguments, fn) },
      }));
    }
    if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

function mapArguments(args: string, fn: TextMapper): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return fn(args, "");
  }
  return JSON.stringify(mapJson(parsed, "", fn));
}

function mapJson(value: unknown, key: string, fn: TextMapper): unknown {
  const context = key ? `${key}: ` : "";
  if (typeof value === "string") return fn(value, context);
  if (typeof value === "number") {
    const text = String(value);
    const mapped = fn(text, context);
    return mapped === text ? value : mapped;
  }
  if (Array.isArray(value)) return value.map((v) => mapJson(v, key, fn));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapJson(v, k, fn)]));
  }
  return value;
}

/**
 * Entities found in `context + text`, moved to offsets within `text`. A span
 * that lies entirely in the context is dropped; one that crosses into the
 * value is cut to the value.
 */
export function withinValue(text: string, found: readonly Detected[], contextLength: number): Detected[] {
  const out: Detected[] = [];
  for (const d of found) {
    let start = Math.max(d.start - contextLength, 0);
    const end = Math.min(d.end - contextLength, text.length);
    while (start < end && /\s/.test(text[start])) start++;
    if (end > start) out.push({ ...d, start, end });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test services/gateway/test/privacy.test.ts`
Expected: PASS, 0 failures (the six new tests included).

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/privacy/mask.ts services/gateway/test/privacy.test.ts
git commit -m "feat(privacy): mask a whole conversation, JSON tool arguments value by value" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C9: The private chat pipeline, the new routes, start-up wiring and the launch gate

**Files:**
- Create: `services/gateway/src/chat.ts`
- Modify: `services/gateway/src/server.ts`, `services/gateway/src/ledger.ts`, `services/gateway/src/dispatch.ts`, `services/gateway/src/main.ts` (replace each whole file)
- Delete: `services/gateway/src/engine.ts` (the retired routing profiles, spec D8)
- Modify: `services/gateway/test/helpers.ts`, `services/gateway/test/gateway.test.ts` (replace each whole file)
- Test: `services/gateway/test/chat.test.ts`

**Interfaces:**
- Consumes: everything from C1 to C8, plus Part A's privacy modules, `HttpError`, `Ledger`, `loadCatalog`, the stubs and the corpus.
- Produces:
  - `chat.ts`: `MAX_CHAT_CHARS = 48_000`; `type ChatOptions = { maxOutputTokens: number; maxAttempts: number; attemptTimeoutMs: number; healthFlagThreshold: number }`; `type ChatDeps = { presidio: PresidioClient; pool: Pool; source: ModelSource; table: ScoreTable; quota: Quota; deny: ExpiringSet; jev: JevClient | undefined; chat: ChatOptions }`; `type ChatRecord` (the ledger's chat fields, spec 8.4); `type ChatResult`; `validateChat(body: unknown, maxOutputTokens: number): Validated`; `messageText(m: Message): string`; `runChat(body: unknown, deps: ChatDeps, signal: AbortSignal): Promise<ChatResult>`; `explainChat(body: unknown, deps: ChatDeps): Promise<ChatRecord>`; `toSse(completion: Record<string, unknown>): string`.
  - `server.ts`: `MAX_TEXT_CHARS`; `type GatewayDeps = ChatDeps & { ledger: Ledger }`; `type ServerOptions = { maxBodyBytes: number; gatewayKey: string | undefined }`; `createGateway(deps: GatewayDeps, opts: ServerOptions): Server`. Routes as spec 8.1, plus the existing `GET /v1/deployments`. `GET /internal/capacity` answers `quota.capacity(source.ready())`, the contract the paywall's guard (B2) reads.
  - `ledger.ts`: `type PrivacyEntry`, `type ChatEntry = { ts; decisionId; endpoint: "chat"; status; latencyMs } & ChatRecord`, `type LedgerEntry = PrivacyEntry | ChatEntry`.
  - `main.ts`: `parseFlags(argv: string[])` with the new flags (spec section 10 and plan refinement 8); `main()` wires either model source.
  - `test/helpers.ts`: `withCardsRemoved`, `listen`, `closeServer`, `post`, `ledgerText` (unchanged), `TEST_TABLE: ScoreTable`, `type TestGatewayOptions = { presidioUrl: string; openRouterUrl?: string; catalog?: Catalog; jev?: boolean; jevTimeoutMs?: number; rpm?: number; attemptTimeoutMs?: number; gatewayKey?: string }`, `type TestGateway = { url; server; presidio; pool; quota; deny; ledgerDir; close() }`, `startTestGateway(o: TestGatewayOptions): Promise<TestGateway>`.

The pipeline follows spec section 4 exactly: validate; detect over every text field; classify locally; mask the whole conversation with one numbering; classify the task (Jev on masked text unless PHI; rules otherwise); Jev's health flag at 0.5 or above makes it PHI; select up to three free models; call them one by one under the data policy (quota checked before every attempt); restore; respond (for `stream: true`, one SSE chunk, then `[DONE]`); write the ledger line. Every refusal is 400 or above: 400 for a bad request or a pinned model that fails a capability filter; 503 when Presidio is down, chat has no capacity, the chain is empty, health data has no no-collection provider, or every attempt failed; the upstream 400, 413 or 422 when the model refused the request itself.

- [ ] **Step 1: Replace the test helpers**

Replace `services/gateway/test/helpers.ts` with:

```ts
/**
 * Shared test helpers: corpus expectations, and a gateway on a loopback port
 * wired like production (Presidio, pool, model source, scores, quota, Jev),
 * with stubs standing in for Presidio and OpenRouter.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { loadCatalog, type Catalog } from "../src/catalog.ts";
import { Ledger } from "../src/ledger.ts";
import { Pool } from "../src/pool.ts";
import { CARD_REMOVED } from "../src/privacy/mask.ts";
import { PresidioClient } from "../src/privacy/presidio.ts";
import { catalogSource, FreePool, openRouterDeployments, type ModelSource } from "../src/routing/freepool.ts";
import { JevClient } from "../src/routing/jev.ts";
import { Quota } from "../src/routing/quota.ts";
import { validateScoreTable, type ScoreTable } from "../src/routing/scores.ts";
import { ExpiringSet } from "../src/routing/select.ts";
import { createGateway } from "../src/server.ts";

/** A corpus text as restore gives it back: card numbers stay removed. */
export function withCardsRemoved(text: string): string {
  let out = text;
  for (const k of KNOWN_VALUES) if (k.type === "CREDIT_CARD") out = out.replaceAll(k.value, CARD_REMOVED);
  return out;
}

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

export const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Every ledger line written so far in `dir`, as raw text. */
export function ledgerText(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("");
}

/**
 * Scores that make the stub models' order predictable. For chat at
 * difficulty 1 (the stub Jev's default answer): bravo 7.5, alpha 7, charlie
 * 6.5. For a PHI request at difficulty 1, charlie's health domain puts it first.
 */
export const TEST_TABLE: ScoreTable = validateScoreTable({
  version: "test",
  weights: { qualityByDifficulty: [0.5, 0.75, 1.0, 1.25, 1.5], taskMatch: 2, domainMatch: 2, speedWhenEasy: { fast: 2, medium: 1, slow: 0 } },
  defaults: {
    qualityBySize: [[300, 8], [100, 7], [25, 6], [8, 5], [0, 3]],
    unknownSizeQuality: 5,
    speedBySize: [[100, "slow"], [25, "medium"], [0, "fast"]],
    unknownSizeSpeed: "medium",
  },
  models: {
    "stub/alpha-70b:free": { quality: 8, tasks: ["chat", "code", "reasoning", "tool_use"], speed: "medium", domains: [] },
    "stub/bravo-27b:free": { quality: 7, tasks: ["chat", "extraction"], speed: "fast", domains: [] },
    "stub/charlie-8b:free": { quality: 5, tasks: ["chat"], speed: "fast", domains: ["health"] },
    "local/small": { quality: 6, tasks: ["chat"], speed: "fast", domains: [] },
    "local/large": { quality: 5, tasks: ["chat"], speed: "medium", domains: [] },
  },
});

export type TestGatewayOptions = {
  presidioUrl: string;
  /** Use the stub OpenRouter at this URL (free pool, key, chat, Jev) instead of a catalog. */
  openRouterUrl?: string;
  /** Catalog mode (the default is config/catalog.json). */
  catalog?: Catalog;
  jev?: boolean;
  jevTimeoutMs?: number;
  rpm?: number;
  attemptTimeoutMs?: number;
  gatewayKey?: string;
};

export type TestGateway = {
  url: string;
  server: Server;
  presidio: PresidioClient;
  pool: Pool;
  quota: Quota;
  deny: ExpiringSet;
  ledgerDir: string;
  close: () => Promise<void>;
};

const OR_KEY_ENV = "OR_TEST_KEY";

export async function startTestGateway(o: TestGatewayOptions): Promise<TestGateway> {
  const presidio = new PresidioClient({ url: o.presidioUrl, threshold: 0.4, timeoutMs: 2000 });
  await presidio.checkHealth();
  const pool = new Pool({ healthIntervalMs: 0, healthTimeoutMs: 1000, unhealthyAfter: 1, cooldownMs: 60_000, env: { [OR_KEY_ENV]: "sk-or-test" } });
  let source: ModelSource;
  const orUrl = o.openRouterUrl;
  if (orUrl) {
    const free = new FreePool({ baseUrl: orUrl, intervalMs: 0, timeoutMs: 2000, onChange: (models) => pool.setModels(openRouterDeployments(models, orUrl, OR_KEY_ENV)) });
    await free.sync();
    source = free;
  } else {
    const catalog = o.catalog ?? loadCatalog("config/catalog.json");
    pool.setModels(catalog.models);
    source = catalogSource(catalog);
  }
  const quota = new Quota({ rpm: o.rpm ?? 1000, keyIntervalMs: 0, ...(orUrl ? { keyUrl: `${orUrl}/api/v1/key`, apiKey: "sk-or-test" } : {}) });
  await quota.refresh();
  const jev = orUrl && o.jev !== false ? new JevClient({ baseUrl: orUrl, apiKey: "sk-or-test", model: "typesafe/jev-1.13", timeoutMs: o.jevTimeoutMs ?? 1000 }) : undefined;
  const deny = new ExpiringSet(60_000);
  const ledgerDir = mkdtempSync(join(tmpdir(), "chainaim-ledger-"));
  const server = createGateway(
    {
      presidio,
      pool,
      source,
      table: TEST_TABLE,
      quota,
      deny,
      jev,
      ledger: new Ledger(ledgerDir),
      chat: { maxOutputTokens: 1024, maxAttempts: 3, attemptTimeoutMs: o.attemptTimeoutMs ?? 2000, healthFlagThreshold: 0.5 },
    },
    { maxBodyBytes: 1 << 20, gatewayKey: o.gatewayKey },
  );
  const url = await listen(server);
  return { url, server, presidio, pool, quota, deny, ledgerDir, close: () => closeServer(server) };
}
```

- [ ] **Step 2: Write the failing chat tests (the launch gate)**

Create `services/gateway/test/chat.test.ts`:

```ts
/**
 * Private chat over real sockets: the stub Presidio, the stub OpenRouter
 * (free pool, key, chat, Jev) and the synthetic corpus. The first suite is
 * the launch gate (spec section 11): nothing identifying leaves, masking
 * round-trips, and the ledger holds no text.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { startStubOpenRouter, type StubOpenRouter } from "../../../scripts/stub-openrouter.ts";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { CORPUS, KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { ledgerText, post, startTestGateway, withCardsRemoved, type TestGateway, type TestGatewayOptions } from "./helpers.ts";

let presidio: StubPresidio;
let or: StubOpenRouter;
before(async () => {
  presidio = await startStubPresidio();
  or = await startStubOpenRouter();
});
after(async () => {
  await presidio.close();
  await or.close();
});

function resetStubs(): void {
  presidio.mode = "ok";
  or.chatModes = {};
  or.chatBodies.length = 0;
  or.decisionBodies.length = 0;
  or.jev = { mode: "ok", task: "chat", difficulty: 1, health: 0.05 };
  or.key = { status: 200, remaining: 1000 };
}

const user = (content: string) => ({ messages: [{ role: "user", content }] });
const leaked = (text: string): string[] => KNOWN_VALUES.map((k) => k.value).filter((v) => text.includes(v));
const chat = (g: TestGateway, body: unknown) => post(`${g.url}/v1/chat/completions`, body);
const capacity = async (g: TestGateway) => (await fetch(`${g.url}/internal/capacity`)).json();
const ALL = ["stub/alpha-70b:free", "stub/bravo-27b:free", "stub/charlie-8b:free"];

describe("launch gate: nothing identifying leaves, masking round-trips, the ledger holds no text", () => {
  let g: TestGateway;
  before(async () => {
    resetStubs();
    g = await startTestGateway({ presidioUrl: presidio.url, openRouterUrl: or.url });
  });
  after(() => g.close());

  for (const item of CORPUS) {
    const phi = item.expect.dataClass === "PHI";
    it(`${item.id}: masked upstream, ${phi ? "no-collection and no Jev" : "Jev on masked text"}, restored for the caller`, async () => {
      const chatBefore = or.chatBodies.length;
      const jevBefore = or.decisionBodies.length;
      const r = await chat(g, { messages: [{ role: "system", content: "You are a careful assistant." }, { role: "user", content: item.text }] });
      assert.equal(r.status, 200);
      const sent = or.chatBodies.slice(chatBefore);
      assert.equal(sent.length, 1);
      assert.deepEqual(leaked(JSON.stringify(sent)), [], "no identifier reached the model");
      assert.deepEqual(sent[0].provider, { data_collection: phi ? "deny" : "allow" });
      assert.equal(r.headers.get("x-chainaim-data-class"), item.expect.dataClass);
      const jevCalls = or.decisionBodies.slice(jevBefore);
      assert.equal(jevCalls.length, phi ? 0 : 1, phi ? "Jev never sees PHI" : "Jev classifies the rest");
      assert.deepEqual(leaked(JSON.stringify(jevCalls)), [], "no identifier reached Jev");
      const answer = (await r.json()).choices[0].message.content;
      assert.equal(answer, `echo: ${withCardsRemoved(item.text)}`, "the caller gets the original values back");
    });
  }

  it("masks tool-call arguments value by value and restores the model's tool call as valid JSON", async () => {
    const before = or.chatBodies.length;
    const args = JSON.stringify({ patient: 'Jane "JR" Roe', file: "C:\\records\\991122.txt", phone: "+1 415 555 0132" });
    const r = await chat(g, {
      messages: [
        { role: "user", content: "Open the chart for Jane Roe." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "open_chart", arguments: args } }] },
        { role: "tool", tool_call_id: "call_0", content: "Chart for Jane Roe (MRN 991122) opened." },
        { role: "user", content: 'call lookup for Jane "JR" Roe at C:\\records\\991122.txt' },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } } }],
    });
    assert.equal(r.status, 200);
    const sent = or.chatBodies.slice(before);
    assert.deepEqual(leaked(JSON.stringify(sent)), []);
    const history = sent[0].messages as { tool_calls?: { function: { arguments: string } }[] }[];
    assert.deepEqual(JSON.parse(history[1].tool_calls![0].function.arguments), { patient: "<PERSON_2>", file: "C:\\records\\<MEDICAL_RECORD_1>.txt", phone: "<PHONE_NUMBER_1>" });
    const call = (await r.json()).choices[0].message.tool_calls[0];
    assert.equal(JSON.parse(call.function.arguments).query, 'call lookup for Jane "JR" Roe at C:\\records\\991122.txt');
  });

  it("keeps every identifier, placeholder and the map out of the ledger", () => {
    const text = ledgerText(g.ledgerDir);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.length >= CORPUS.length);
    assert.deepEqual(leaked(text), []);
    assert.ok(!/<[A-Z_]+_\d+>/.test(text), "no placeholder in the ledger");
    for (const e of lines) {
      assert.equal(e.endpoint, "chat");
      for (const k of ["map", "maskedText", "messages", "content", "text"]) assert.ok(!(k in e), `${k} is in a ledger line`);
      for (const a of e.attempts) for (const k of Object.keys(a)) assert.ok(["model", "outcome", "status", "ms"].includes(k), `attempt field ${k}`);
    }
  });
});

describe("classification", () => {
  let g: TestGateway;
  before(async () => {
    resetStubs();
    g = await startTestGateway({ presidioUrl: presidio.url, openRouterUrl: or.url, jevTimeoutMs: 300 });
  });
  after(() => g.close());
  beforeEach(resetStubs);

  it("sends Jev only masked text", async () => {
    const r = await chat(g, user("Draft a note to Priya Sharma about the Friday meeting."));
    assert.equal(r.headers.get("x-chainaim-classifier"), "jev");
    const request = (or.decisionBodies[0].state as { request: string }).request;
    assert.ok(request.includes("<PERSON_1>") && !request.includes("Priya"));
  });

  it("Jev's health flag makes the request PHI and the call no-collection", async () => {
    or.jev.health = 0.9;
    const r = await chat(g, user("Draft a note to Priya Sharma about the Friday meeting."));
    assert.equal(r.headers.get("x-chainaim-data-class"), "PHI");
    assert.deepEqual(or.chatBodies.at(-1)!.provider, { data_collection: "deny" });
  });

  for (const mode of ["slow", "fail500", "malformed"] as const) {
    it(`falls back to the rules when Jev is ${mode}`, async () => {
      or.jev.mode = mode;
      const r = await chat(g, user("What is the capital of France?"));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-chainaim-classifier"), "rules");
    });
  }
});

describe("selection, request shaping and the other routes", () => {
  let g: TestGateway;
  before(async () => {
    resetStubs();
    g = await startTestGateway({ presidioUrl: presidio.url, openRouterUrl: or.url });
  });
  after(() => g.close());
  beforeEach(resetStubs);

  it("ignores chainaim/auto and serves the top-scored free model", async () => {
    const r = await chat(g, { model: "chainaim/auto", ...user("hi") });
    assert.equal(r.headers.get("x-chainaim-model"), "stub/bravo-27b:free");
  });

  it("serves a pinned free model alone", async () => {
    const r = await chat(g, { model: "stub/charlie-8b:free", ...user("hi") });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "stub/charlie-8b:free");
  });

  it("refuses a pinned model that fails a filter, naming the filter", async () => {
    const r = await chat(g, { model: "stub/charlie-8b:free", ...user("hi"), tools: [{ type: "function", function: { name: "lookup" } }] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /tools/);
  });

  it("sends a JSON-output request only to a model that supports it", async () => {
    const r = await chat(g, { ...user("List three colours."), response_format: { type: "json_object" } });
    assert.equal(r.headers.get("x-chainaim-model"), "stub/alpha-70b:free");
  });

  it("drops client routing and identity fields, caps max_tokens and never streams upstream", async () => {
    await (
      await chat(g, {
        ...user("hi"),
        max_tokens: 5000,
        stream: true,
        temperature: 0.2,
        provider: { data_collection: "allow", order: ["x"] },
        models: ["a"],
        route: "fallback",
        transforms: ["t"],
        plugins: [{ id: "web" }],
        user: "jane.roe@example.com",
        metadata: { who: "Jane Roe" },
        prediction: { type: "content", content: "Jane Roe" },
      })
    ).text();
    const b = or.chatBodies.at(-1)!;
    for (const k of ["models", "route", "transforms", "plugins", "user", "metadata", "prediction"]) assert.ok(!(k in b), k);
    assert.deepEqual(b.provider, { data_collection: "allow" });
    assert.deepEqual([b.max_tokens, b.temperature, b.stream], [1024, 0.2, false]);
  });

  it("emulates streaming with one chunk carrying the restored answer, then [DONE]", async () => {
    const r = await chat(g, { ...user("Say hi to Jane Roe."), stream: true });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const [first, done] = (await r.text()).trim().split("\n\n");
    assert.equal(done, "data: [DONE]");
    const chunk = JSON.parse(first.slice("data: ".length));
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.equal(chunk.choices[0].delta.content, "echo: Say hi to Jane Roe.");
  });

  it("refuses image parts and more than 48,000 characters with 400, sending nothing", async () => {
    const image = await chat(g, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }] }] });
    assert.equal(image.status, 400);
    assert.equal((await chat(g, user("x".repeat(48_001)))).status, 400);
    assert.equal(or.chatBodies.length, 0);
  });

  it("lists chainaim/auto and the free pool without the excluded models", async () => {
    const ids = (await (await fetch(`${g.url}/v1/models`)).json()).data.map((m: { id: string }) => m.id);
    assert.deepEqual(ids, ["chainaim/auto", ...ALL]);
  });

  it("explain returns the decision without calling a chat model or echoing text", async () => {
    const r = await post(`${g.url}/v1/route/explain`, user("Draft a note to Priya Sharma."));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.decision.chain, ["stub/bravo-27b:free", "stub/alpha-70b:free", "stub/charlie-8b:free"]);
    assert.equal(j.decision.dataClass, "PII");
    assert.equal(or.chatBodies.length, 0);
    assert.ok(!JSON.stringify(j).includes("Priya"));
  });

  it("reports capacity for the paywall's guard", async () => {
    assert.deepEqual(await capacity(g), { chatAvailable: true });
  });
});

describe("limits and failures", () => {
  let g: TestGateway | undefined;
  beforeEach(resetStubs);
  afterEach(async () => {
    await g?.close();
    g = undefined;
  });
  const start = async (extra: Partial<TestGatewayOptions> = {}): Promise<TestGateway> => {
    g = await startTestGateway({ presidioUrl: presidio.url, openRouterUrl: or.url, ...extra });
    return g;
  };

  it("an account-level 429 stops the chain and makes chat unavailable", async () => {
    const gw = await start();
    or.chatModes["stub/bravo-27b:free"] = "account429";
    const r = await chat(gw, user("hi"));
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("x-chainaim-attempts"), "1");
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    const cap = await capacity(gw);
    assert.deepEqual([cap.chatAvailable, cap.reason], [false, "rate_limited"]);
  });

  it("a provider 429 moves on to the next model and cools the first one down", async () => {
    const gw = await start();
    or.chatModes["stub/bravo-27b:free"] = "provider429";
    const r = await chat(gw, user("hi"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "stub/alpha-70b:free");
    assert.equal(r.headers.get("x-chainaim-attempts"), "2");
    assert.equal(gw.pool.isCoolingDown("stub/bravo-27b:free"), true);
  });

  it("a timeout moves on to the next model", async () => {
    const gw = await start({ attemptTimeoutMs: 300 });
    or.chatModes["stub/bravo-27b:free"] = "slow";
    const r = await chat(gw, user("hi"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "stub/alpha-70b:free");
  });

  it("a request every model rejects returns that 4xx and cools nothing down", async () => {
    const gw = await start();
    for (const id of ALL) or.chatModes[id] = "badrequest";
    const r = await chat(gw, user("hi"));
    assert.equal(r.status, 400);
    assert.equal(r.headers.get("x-chainaim-attempts"), "3");
    assert.equal(gw.pool.isCoolingDown("stub/bravo-27b:free"), false);
  });

  it("health data goes only to no-collection providers; a refusal is cached and costs nothing", async () => {
    const gw = await start();
    for (const id of ALL) or.chatModes[id] = id === "stub/bravo-27b:free" ? "policy503" : "policy404";
    const phi = user("Patient Jane Roe, MRN 991122, was diagnosed with diabetes last spring.");
    const r1 = await chat(gw, phi);
    assert.equal(r1.status, 503);
    assert.match((await r1.json()).error.message, /do not collect data/);
    for (const id of ALL) assert.equal(gw.deny.has(id), true, id);
    const calls = or.chatBodies.length;
    const r2 = await chat(gw, phi);
    assert.equal(r2.status, 503, "every model is cached, so nobody is called");
    assert.equal(or.chatBodies.length, calls);
    assert.equal((await chat(gw, user("What is the capital of France?"))).status, 200, "requests that are not PHI still go through");
  });

  it("the per-minute window refuses the call beyond the limit", async () => {
    const gw = await start({ rpm: 2 });
    assert.equal((await chat(gw, user("hi"))).status, 200);
    assert.equal((await chat(gw, user("hi"))).status, 200);
    const r = await chat(gw, user("hi"));
    assert.equal(r.status, 503);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    const cap = await capacity(gw);
    assert.deepEqual([cap.chatAvailable, cap.reason], [false, "rate_limited"]);
  });

  it("a rejected key makes chat unavailable until a key read succeeds", async () => {
    const gw = await start();
    or.chatModes["stub/bravo-27b:free"] = "unauthorized";
    or.key.status = 401;
    assert.equal((await chat(gw, user("hi"))).status, 503);
    assert.equal((await capacity(gw)).reason, "key_rejected");
    or.key.status = 200;
    await gw.quota.refresh();
    assert.equal((await capacity(gw)).chatAvailable, true);
  });

  it("fails closed: with Presidio down, chat answers 503 and nothing reaches OpenRouter", async () => {
    const gw = await start();
    presidio.mode = "fail";
    const r = await chat(gw, user("Jane Roe needs a refill."));
    assert.equal(r.status, 503);
    assert.equal(or.chatBodies.length + or.decisionBodies.length, 0);
  });
});
```

- [ ] **Step 3: Rewrite the catalog-mode gateway tests**

The profile tests go with the retired profiles (spec section 11, item 10). Replace `services/gateway/test/gateway.test.ts` with:

```ts
/**
 * Gateway tests in catalog mode: upstreams are real HTTP servers on loopback
 * ports that behave like OpenAI-compatible model servers (healthy, failing,
 * slow), so fallback, cooldown, the key and the ledger run over real sockets.
 * Chat always runs the privacy pipeline (the stub Presidio); Jev is off, so
 * the rules classify.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { CatalogError, validateCatalog, type Catalog } from "../src/catalog.ts";
import { parseFlags } from "../src/main.ts";
import { closeServer, ledgerText, listen, post, startTestGateway } from "./helpers.ts";

type Behaviour = "ok" | "fail500" | "slow";

async function upstream(name: string, behaviour: Behaviour): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(behaviour === "fail500" ? 503 : 200).end("{}");
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (behaviour === "fail500") {
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
      return;
    }
    if (behaviour === "slow") await new Promise((r) => setTimeout(r, 400));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: `hi from ${name}` } }] }));
  });
  return { server, url: await listen(server) };
}

const caps = { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: true, supportsVision: false };
const chains = (order: string[]) => ({ SIMPLE: order, MEDIUM: order, COMPLEX: order, REASONING: order });
const profiles = (ids: string[]) => ({ auto: chains(ids), eco: chains(ids), premium: chains(ids) });

function catalogFor(small: string[], large: string[]): Catalog {
  const deployments = (name: string, urls: string[]) =>
    urls.map((u, i) => ({ id: `${name}@${i}`, adapter: "openai", baseUrl: `${u}/v1`, servedModel: name, healthUrl: `${u}/health` }));
  return validateCatalog({
    version: "test",
    models: [
      { id: "local/small", zone: "local", capabilities: caps, pricing: { inputPerM: 0.01, outputPerM: 0.02 }, deployments: deployments("small", small) },
      { id: "local/large", zone: "local", capabilities: caps, pricing: { inputPerM: 0.1, outputPerM: 0.2 }, deployments: deployments("large", large) },
    ],
    profiles: profiles(["local/small", "local/large"]),
  });
}

describe("catalog validation", () => {
  const one = (deployment: Record<string, unknown>, id = "local/a") => ({
    version: "x",
    models: [{ id, zone: "local", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 }, deployments: [{ id: "a", adapter: "openai", baseUrl: "http://127.0.0.1:1/v1", servedModel: "a", ...deployment }] }],
    profiles: profiles([id]),
  });

  it("rejects an unknown model id in a profile chain", () => {
    assert.throws(() => validateCatalog({ ...one({}), profiles: { ...profiles(["local/a"]), auto: chains(["local/nope"]) } }), CatalogError);
  });
  it("rejects a secret value where an env var name is expected", () => {
    assert.throws(() => validateCatalog(one({ apiKeyEnv: "sk-live-123" })), /environment variable NAME/);
  });
  it("reserves the chainaim/ namespace", () => {
    assert.throws(() => validateCatalog(one({}, "chainaim/auto")), /reserved/);
  });
  it("accepts probe: false and rejects a probe that is not a boolean", () => {
    assert.equal(validateCatalog(one({ probe: false })).models[0].deployments[0].probe, false);
    assert.throws(() => validateCatalog(one({ probe: "no" })), /probe/);
  });
});

describe("flags", () => {
  it("default to catalog mode with the spec's values", () => {
    const f = parseFlags([]);
    assert.deepEqual(
      [f.modelSource, f.maxOutputTokens, f.presidioThreshold, f.jev, f.jevModel, f.jevTimeoutMs, f.healthFlagThreshold, f.freeSyncIntervalMs, f.freeRpm, f.openRouterKeyEnv],
      ["catalog", 1024, 0.4, true, "typesafe/jev-1.13", 800, 0.5, 21_600_000, 20, "OPENROUTER_API_KEY"],
    );
  });
  it("reject an unknown model source, a threshold above 1 and a key where a variable name belongs", () => {
    assert.throws(() => parseFlags(["--model-source", "paid"]), /model-source/);
    assert.throws(() => parseFlags(["--presidio-threshold", "2"]), /presidio-threshold/);
    assert.throws(() => parseFlags(["--openrouter-key-env", "sk-or-v1-abc"]), /openrouter-key-env/);
  });
});

describe("catalog-mode chat over real sockets", () => {
  let presidio: StubPresidio;
  const ups: { server: Server; url: string }[] = [];
  before(async () => {
    presidio = await startStubPresidio();
    ups.push(await upstream("small-ok", "ok"), await upstream("large-ok", "ok"), await upstream("small-down", "fail500"), await upstream("slow", "slow"));
  });
  after(async () => {
    await Promise.all(ups.map((u) => closeServer(u.server)));
    await presidio.close();
  });
  const start = (catalog: Catalog, extra: { attemptTimeoutMs?: number; gatewayKey?: string } = {}) => startTestGateway({ presidioUrl: presidio.url, catalog, ...extra });
  const ask = (url: string, content: string, headers: Record<string, string> = {}) => post(`${url}/v1/chat/completions`, { messages: [{ role: "user", content }] }, headers);

  it("serves the best-scored model and reports the decision in headers", async () => {
    const g = await start(catalogFor([ups[0].url], [ups[1].url]));
    const r = await ask(g.url, "What is 2+2?");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/small");
    assert.equal(r.headers.get("x-chainaim-classifier"), "rules");
    assert.equal(r.headers.get("x-chainaim-data-class"), "none");
    assert.equal(r.headers.get("x-chainaim-attempts"), "1");
    assert.equal((await r.json()).model, "small", "the upstream received the deployment's servedModel");
    await g.close();
  });

  it("falls back to the next model on a 5xx and cools the first one down", async () => {
    const g = await start(catalogFor([ups[2].url], [ups[1].url]));
    const r = await ask(g.url, "What is 2+2?");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/large");
    assert.equal(r.headers.get("x-chainaim-attempts"), "2");
    assert.equal(g.pool.isCoolingDown("local/small"), true);
    await g.close();
  });

  it("uses the healthy replica of a model before changing model", async () => {
    const g = await start(catalogFor([ups[2].url, ups[0].url], [ups[1].url]));
    await g.pool.checkAll(); // the probe takes small@0 out before any request
    const r = await ask(g.url, "What is 2+2?");
    assert.equal(r.headers.get("x-chainaim-model"), "local/small");
    assert.equal(r.headers.get("x-chainaim-attempts"), "1");
    await g.close();
  });

  it("times out a slow model and falls back", async () => {
    const g = await start(catalogFor([ups[3].url], [ups[1].url]), { attemptTimeoutMs: 100 });
    const r = await ask(g.url, "What is 2+2?");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/large");
    await g.close();
  });

  it("answers 503 with the attempt count when every model fails", async () => {
    const g = await start(catalogFor([ups[2].url], [ups[2].url]));
    const r = await ask(g.url, "hi");
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("x-chainaim-attempts"), "2");
    await g.close();
  });

  it("emulates streaming: one chunk, then [DONE]", async () => {
    const g = await start(catalogFor([ups[0].url], [ups[1].url]));
    const r = await post(`${g.url}/v1/chat/completions`, { stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const text = await r.text();
    assert.match(text, /hi from small-ok/);
    assert.ok(text.endsWith("data: [DONE]\n\n"));
    await g.close();
  });

  it("enforces the gateway key; /healthz stays open", async () => {
    const g = await start(catalogFor([ups[0].url], [ups[1].url]), { gatewayKey: "test-key-123" });
    assert.equal((await ask(g.url, "hi")).status, 401);
    assert.equal((await ask(g.url, "hi", { authorization: "Bearer test-key-123" })).status, 200);
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200);
    await g.close();
  });

  it("writes a ledger line with no prompt text", async () => {
    const g = await start(catalogFor([ups[0].url], [ups[1].url]));
    const secret = "Patient Jane Roe MRN 991122";
    await (await ask(g.url, secret)).text();
    const text = ledgerText(g.ledgerDir);
    assert.ok(!text.includes("Jane") && !text.includes("991122"), "the ledger holds no prompt text");
    const entry = JSON.parse(text.trim());
    assert.deepEqual([entry.served, entry.promptChars, entry.dataClass], ["local/small", secret.length, "PHI"]);
    await g.close();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test services/gateway/test/chat.test.ts services/gateway/test/gateway.test.ts`
Expected: FAIL: `createGateway` still takes the old deps, and `../src/main.ts` has no `modelSource` flag.

- [ ] **Step 5: Write the chat pipeline**

Create `services/gateway/src/chat.ts`:

```ts
/**
 * Private chat (spec section 4): validate, detect, classify, mask, classify
 * the task, select free models, call them, restore. Unscanned text never
 * leaves: messages are rebuilt field by field, and only the fields in
 * PASSTHROUGH are copied from the request.
 */
import { attemptChat, type ModelAttempt } from "./dispatch.ts";
import { HttpError } from "./errors.ts";
import { REQUEST_FAULTS, shapeBody } from "./openrouter.ts";
import type { Pool } from "./pool.ts";
import { classify, countTypes, type Classes, type DataClass, type FoundClass } from "./privacy/classify.ts";
import { Masker, mapConversation, withinValue, type Message } from "./privacy/mask.ts";
import { PresidioError, type PresidioClient } from "./privacy/presidio.ts";
import { restoreCompletion } from "./privacy/restore.ts";
import { classifyTask, type TaskClass, type TaskInput } from "./routing/classify.ts";
import type { ModelSource } from "./routing/freepool.ts";
import type { JevClient } from "./routing/jev.ts";
import type { Quota } from "./routing/quota.ts";
import type { ScoreTable, Task } from "./routing/scores.ts";
import { failedFilter, rank, type ExpiringSet, type Need } from "./routing/select.ts";

/** At most this many characters of message text (spec section 4). */
export const MAX_CHAT_CHARS = 48_000;
/** The chain is the top three by score (spec section 6). */
const CHAIN_LENGTH = 3;
const NO_DENY_PROVIDER = "health data only goes to model providers that do not collect data, and none is available right now; you were not charged";

export type ChatOptions = { maxOutputTokens: number; maxAttempts: number; attemptTimeoutMs: number; healthFlagThreshold: number };
export type ChatDeps = {
  presidio: PresidioClient;
  pool: Pool;
  source: ModelSource;
  table: ScoreTable;
  quota: Quota;
  deny: ExpiringSet;
  jev: JevClient | undefined;
  chat: ChatOptions;
};

/** What the ledger records about a chat request (spec 8.4): never text, placeholders or the map. */
export type ChatRecord = {
  promptChars: number;
  attempts: ModelAttempt[];
  dataClass?: DataClass;
  found?: FoundClass[];
  entityCounts?: Record<string, number>;
  cardsRemoved?: number;
  classifier?: "jev" | "rules";
  task?: Task;
  difficulty?: number;
  jev?: TaskClass["jev"];
  dataCollection?: "allow" | "deny";
  chain?: string[];
  served?: string;
  unresolvedPlaceholders?: number;
};

export type ChatResult =
  | { ok: true; completion: Record<string, unknown>; stream: boolean; record: ChatRecord }
  | { ok: false; status: number; message: string; retryAfterSec?: number; record: ChatRecord };

export type Validated = {
  messages: Message[];
  raw: Record<string, unknown>;
  model: string | undefined;
  maxTokens: number;
  stream: boolean;
  hasTools: boolean;
  wantsJson: boolean;
  chars: number;
};

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkMessage(m: unknown, i: number): Message {
  const at = `messages[${i}]`;
  if (!isObj(m)) throw new HttpError(400, `${at}: must be an object`);
  const { role, content } = m;
  if (typeof role !== "string" || !ROLES.has(role)) throw new HttpError(400, `${at}.role: one of ${[...ROLES].join(", ")}`);
  const out: Message = { role };
  if (typeof content === "string" || content === null) out.content = content;
  else if (Array.isArray(content)) {
    out.content = content.map((p, j) => {
      if (!isObj(p) || p.type !== "text") throw new HttpError(400, `${at}.content[${j}]: only text parts are accepted; images and other media are refused`);
      if (typeof p.text !== "string") throw new HttpError(400, `${at}.content[${j}].text: a string is required`);
      return { type: "text" as const, text: p.text };
    });
  } else if (content !== undefined) throw new HttpError(400, `${at}.content: a string, an array of text parts, or null`);
  if (m.tool_calls !== undefined) {
    if (!Array.isArray(m.tool_calls)) throw new HttpError(400, `${at}.tool_calls: an array is required`);
    out.tool_calls = m.tool_calls.map((c, j) => {
      const fn = isObj(c) ? c.function : undefined;
      if (!isObj(fn) || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
        throw new HttpError(400, `${at}.tool_calls[${j}].function: name and arguments strings are required`);
      }
      const id = isObj(c) && typeof c.id === "string" ? { id: c.id } : {};
      return { ...id, type: "function" as const, function: { name: fn.name, arguments: fn.arguments } };
    });
  }
  if (typeof m.tool_call_id === "string") out.tool_call_id = m.tool_call_id;
  return out;
}

/** Spec section 4, chat step 1. Throws HttpError(400); nothing has been scanned or logged yet. */
export function validateChat(body: unknown, maxOutputTokens: number): Validated {
  if (!isObj(body)) throw new HttpError(400, "request body must be a JSON object");
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new HttpError(400, "messages: a non-empty array is required");
  const messages = body.messages.map(checkMessage);
  let chars = 0;
  mapConversation(messages, (text) => {
    chars += text.length;
    return text;
  });
  if (chars > MAX_CHAT_CHARS) throw new HttpError(400, `messages hold ${chars} characters of text; the limit is ${MAX_CHAT_CHARS}`);
  const requested = body.max_completion_tokens ?? body.max_tokens;
  if (requested !== undefined && requested !== null && (!Number.isInteger(requested) || (requested as number) < 1)) {
    throw new HttpError(400, "max_tokens must be a positive integer");
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const format = isObj(body.response_format) ? body.response_format.type : undefined;
  return {
    messages,
    raw: body,
    model: typeof body.model === "string" ? body.model : undefined,
    maxTokens: Math.min(typeof requested === "number" ? requested : maxOutputTokens, maxOutputTokens),
    stream: body.stream === true,
    hasTools: tools.length > 0 && body.tool_choice !== "none",
    wantsJson: format === "json_object" || format === "json_schema",
    chars,
  };
}

/** The text Jev and the rules read for one message: its content, then its tool calls. */
export function messageText(m: Message): string {
  const parts: string[] = [];
  if (typeof m.content === "string") parts.push(m.content);
  else if (Array.isArray(m.content)) for (const p of m.content) parts.push(p.text);
  for (const c of m.tool_calls ?? []) parts.push(`${c.function.name}(${c.function.arguments})`);
  return parts.join("\n");
}

function taskInput(masked: readonly Message[], v: Validated): TaskInput {
  const isSystem = (m: Message) => m.role === "system" || m.role === "developer";
  const turns = masked.filter((m) => !isSystem(m)).map((m) => ({ role: m.role, text: messageText(m) }));
  const toolChars = Array.isArray(v.raw.tools) ? JSON.stringify(v.raw.tools).length : 0;
  const chars = masked.reduce((n, m) => n + messageText(m).length, 0) + toolChars;
  return {
    system: masked.filter(isSystem).map(messageText).join("\n"),
    turns,
    lastUser: turns.filter((t) => t.role === "user").at(-1)?.text ?? "",
    hasTools: v.hasTools,
    toolChoice: v.raw.tool_choice,
    promptTokens: Math.ceil(chars / 4), // the route engine's convention: characters / 4
  };
}

type Prepared = { v: Validated; masked: Message[]; masker: Masker; types: string[]; local: Classes; input: TaskInput };

/** Steps 2 to 4: detect over every text field, classify locally, mask with one shared numbering. */
async function prepare(v: Validated, deps: ChatDeps, record: ChatRecord): Promise<Prepared> {
  const segments: { text: string; context: string }[] = [];
  mapConversation(v.messages, (text, context) => {
    segments.push({ text, context });
    return text;
  });
  const found = await deps.presidio.analyzeAll(segments.map((s) => s.context + s.text));
  const entities = found.map((f, i) => withinValue(segments[i].text, f, segments[i].context.length));
  const all = entities.flat();
  const types = all.map((e) => e.type);
  const local = classify(types);
  const masker = new Masker();
  let next = 0;
  const masked = mapConversation(v.messages, (text) => masker.mask(text, entities[next++]));
  Object.assign(record, { dataClass: local.dataClass, found: local.found, entityCounts: countTypes(all), cardsRemoved: masker.cardsRemoved });
  return { v, masked, masker, types, local, input: taskInput(masked, v) };
}

type Decision = { classes: Classes; chain: string[] };

/** Steps 5 and 6: classify the task (Jev never sees PHI), apply Jev's health flag, choose the chain. */
async function decide(p: Prepared, deps: ChatDeps, record: ChatRecord): Promise<Decision> {
  if (!deps.source.ready()) throw new HttpError(503, "no chat models are available right now; you were not charged");
  const localPhi = p.local.dataClass === "PHI";
  const task = await classifyTask(p.input, deps.jev, localPhi);
  const flagged = !localPhi && task.health !== null && task.health >= deps.chat.healthFlagThreshold;
  const classes = flagged ? classify(p.types, true) : p.local;
  const phi = classes.dataClass === "PHI";
  Object.assign(record, {
    dataClass: classes.dataClass,
    found: classes.found,
    classifier: task.classifier,
    task: task.task,
    difficulty: task.difficulty,
    jev: task.jev,
    dataCollection: classes.policy.dataCollection,
  });

  const need: Need = { task: task.task, difficulty: task.difficulty, phi, hasTools: p.v.hasTools, wantsJson: p.v.wantsJson, promptTokens: p.input.promptTokens, maxTokens: p.v.maxTokens };
  const excluders = { coolingDown: (id: string) => deps.pool.isCoolingDown(id), denyUnavailable: (id: string) => deps.deny.has(id) };
  const models = deps.source.models();
  const pinned = p.v.model === undefined ? undefined : models.find((m) => m.id === p.v.model);
  let chain: string[];
  if (pinned) {
    // A model named by the client is tried alone; any other name, chainaim/auto included, is ignored.
    const why = failedFilter(pinned, need, excluders);
    if (why === "cooling_down" || why === "data_policy") throw new HttpError(503, `model ${pinned.id} is unavailable right now (${why}); you were not charged`);
    if (why) throw new HttpError(400, `model ${pinned.id} cannot serve this request (${why})`);
    chain = [pinned.id];
  } else {
    const { ranked, excluded } = rank(models, deps.table, need, excluders);
    chain = ranked.slice(0, CHAIN_LENGTH).map((r) => r.id);
    if (chain.length === 0) {
      const policy = phi && Object.values(excluded).includes("data_policy");
      throw new HttpError(503, policy ? NO_DENY_PROVIDER : "no model can serve this request right now; you were not charged");
    }
  }
  record.chain = chain;
  return { classes, chain };
}

type ChainOutcome = { ok: true; model: string; completion: Record<string, unknown> } | { ok: false; status: number; message: string; retryAfterSec?: number };

/** Step 7 (spec section 7): every attempt counts against the quota; account limits and a rejected key stop the chain. */
async function callChain(d: Decision, p: Prepared, deps: ChatDeps, signal: AbortSignal, record: ChatRecord): Promise<ChainOutcome> {
  const body = shapeBody(p.v.raw, p.masked, p.v.maxTokens);
  const dataCollection = d.classes.policy.dataCollection;
  const attempts = record.attempts;
  for (const model of d.chain) {
    if (attempts.filter((a) => a.outcome !== "no_deployment").length >= deps.chat.maxAttempts) break;
    if (!deps.quota.take()) {
      const cap = deps.quota.capacity(true);
      return { ok: false, status: 503, message: `free-model capacity is used up right now (${cap.reason ?? "rate_limited"}); you were not charged`, retryAfterSec: cap.retryAfterSec };
    }
    const r = await attemptChat(model, body, dataCollection, deps.pool, deps.chat.attemptTimeoutMs, signal);
    attempts.push(r.attempt);
    switch (r.attempt.outcome) {
      case "ok":
        return { ok: true, model, completion: r.completion! };
      case "client_abort":
        return { ok: false, status: 499, message: "client closed the request" };
      case "rate_limited_account":
        deps.quota.onAccountLimit(r.accountScope ?? "minute");
        return { ok: false, status: 503, message: "the free-model rate limit was reached; you were not charged", retryAfterSec: deps.quota.capacity(true).retryAfterSec ?? 60 };
      case "key_rejected":
        deps.quota.onKeyRejected();
        return { ok: false, status: 503, message: "the model provider rejected the gateway's key; you were not charged" };
      case "data_policy_unavailable":
        deps.deny.add(model);
        break;
      default:
        break; // a provider limit, an upstream error, a timeout, a network error or no deployment: try the next model
    }
  }
  const last = attempts.at(-1);
  if (last?.outcome === "upstream_error" && last.status !== undefined && REQUEST_FAULTS.has(last.status)) {
    return { ok: false, status: last.status, message: `the model rejected the request (HTTP ${last.status})` };
  }
  if (dataCollection === "deny" && attempts.length > 0 && attempts.every((a) => a.outcome === "data_policy_unavailable")) {
    return { ok: false, status: 503, message: NO_DENY_PROVIDER };
  }
  return { ok: false, status: 503, message: "every model tried failed; you were not charged" };
}

function refusal(e: unknown): { status: number; message: string } {
  if (e instanceof PresidioError) return { status: 503, message: "the privacy scanner is unavailable; nothing was sent to a model and you were not charged" };
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  throw e;
}

/** The whole pipeline. A 400 from validation is thrown (not logged); every later refusal comes back with its record for the ledger. */
export async function runChat(body: unknown, deps: ChatDeps, signal: AbortSignal): Promise<ChatResult> {
  const v = validateChat(body, deps.chat.maxOutputTokens);
  const record: ChatRecord = { promptChars: v.chars, attempts: [] };
  let p: Prepared;
  let d: Decision;
  try {
    p = await prepare(v, deps, record);
    d = await decide(p, deps, record);
  } catch (e) {
    return { ok: false, ...refusal(e), record };
  }
  const outcome = await callChain(d, p, deps, signal, record);
  if (!outcome.ok) return { ok: false, status: outcome.status, message: outcome.message, retryAfterSec: outcome.retryAfterSec, record };
  const stats = { unresolved: 0 };
  restoreCompletion(outcome.completion, p.masker.map, stats);
  record.served = outcome.model;
  record.unresolvedPlaceholders = stats.unresolved;
  return { ok: true, completion: outcome.completion, stream: v.stream, record };
}

/** The decision for a chat request without calling a chat model (Jev is called). It holds no text. */
export async function explainChat(body: unknown, deps: ChatDeps): Promise<ChatRecord> {
  const v = validateChat(body, deps.chat.maxOutputTokens);
  const record: ChatRecord = { promptChars: v.chars, attempts: [] };
  try {
    await decide(await prepare(v, deps, record), deps, record);
  } catch (e) {
    const r = refusal(e);
    throw new HttpError(r.status, r.message);
  }
  return record;
}

/** Streaming is emulated (spec section 4): one chunk with the whole restored answer, then [DONE]. */
export function toSse(completion: Record<string, unknown>): string {
  const choices = Array.isArray(completion.choices) ? (completion.choices as Record<string, unknown>[]) : [];
  const chunk = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: choices.map((c, i) => {
      const message = isObj(c.message) ? c.message : {};
      const delta: Record<string, unknown> = { role: "assistant" };
      for (const field of ["content", "reasoning", "refusal"]) if (typeof message[field] === "string") delta[field] = message[field];
      if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls.map((t, j) => ({ index: j, ...(isObj(t) ? t : {}) }));
      return { index: typeof c.index === "number" ? c.index : i, delta, finish_reason: c.finish_reason ?? null };
    }),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
```

- [ ] **Step 6: Replace the ledger, the dispatcher and the server**

Replace `services/gateway/src/ledger.ts` with:

```ts
/**
 * Decision ledger: one JSON line per request. It records classes, counts,
 * sizes, the routing decision and every attempt. It never records request
 * or response text, placeholders, the placeholder map, tool arguments or
 * upstream error bodies (tested with the synthetic corpus).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatRecord } from "./chat.ts";
import type { DataClass, FoundClass } from "./privacy/classify.ts";

type Base = { ts: string; decisionId: string; status: number; latencyMs: number };

/** A scan or mask call (spec 8.4): what was found, never the text. */
export type PrivacyEntry = Base & {
  endpoint: "scan" | "mask";
  textChars: number;
  dataClass?: DataClass;
  found?: FoundClass[];
  entityCounts?: Record<string, number>;
  cardsRemoved?: number;
};

/** A chat call (spec 8.4). */
export type ChatEntry = Base & { endpoint: "chat" } & ChatRecord;

export type LedgerEntry = PrivacyEntry | ChatEntry;

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

In `services/gateway/src/dispatch.ts`, delete the retired streaming path: the `Attempt`, `DispatchOptions` and `DispatchResult` types, `openAiRequest` and `dispatch`, and the `ChatRequest` and `Deployment` imports they used. Keep the imports of `categorize`, `DataCollection`, `Outcome`, `HealthEffect` and `Pool`, and everything Task C5 added. Replace the file's header comment with:

```ts
/**
 * Dispatch: one attempt of one model (spec section 7). The chat pipeline
 * (chat.ts) walks the chain, applying the quota and the deny-unavailable
 * cache between attempts.
 */
```

Delete `services/gateway/src/engine.ts` (`git rm services/gateway/src/engine.ts`).

Replace `services/gateway/src/server.ts` with:

```ts
/**
 * ChainAim gateway HTTP surface (spec section 8). It is private: only the
 * paywall reaches it, with the gateway key.
 *
 *   POST /v1/privacy/scan       entities and data class; no model is called
 *   POST /v1/privacy/mask       masked text and the placeholder map
 *   POST /v1/chat/completions   private chat: mask, route, call, restore
 *   POST /v1/route/explain      the chat decision without a chat-model call (calls Jev)
 *   GET  /v1/models             chainaim/auto and the current free pool
 *   GET  /internal/capacity     whether chat can be served now (the paywall's guard)
 *   GET  /v1/deployments        per-deployment health
 *   GET  /healthz               200 when Presidio answered its last check (no auth)
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { explainChat, runChat, toSse, type ChatDeps } from "./chat.ts";
import { HttpError } from "./errors.ts";
import type { Ledger } from "./ledger.ts";
import { classify, countTypes } from "./privacy/classify.ts";
import type { Detected } from "./privacy/entities.ts";
import { Masker } from "./privacy/mask.ts";
import { PresidioError } from "./privacy/presidio.ts";

/** Scan and mask accept a text of 1 to this many characters. */
export const MAX_TEXT_CHARS = 20_000;

export type GatewayDeps = ChatDeps & { ledger: Ledger };
export type ServerOptions = {
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
  const { presidio, ledger } = deps;

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

  /** Private chat (spec section 4); the headers are spec 8.2's. */
  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const decisionId = randomUUID();
    const body = await readJson(req, opts.maxBodyBytes);
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const result = await runChat(body, deps, abort.signal);
    const status = result.ok ? 200 : result.status;
    ledger.write({ ts: new Date().toISOString(), decisionId, endpoint: "chat", ...result.record, status, latencyMs: Math.round(performance.now() - started) });

    const headers: Record<string, string> = { "x-chainaim-decision-id": decisionId, "x-chainaim-attempts": String(result.record.attempts.length) };
    if (!result.ok) {
      if (result.status === 499) return; // the client is gone
      if (result.retryAfterSec !== undefined) headers["retry-after"] = String(result.retryAfterSec);
      sendError(res, result.status, result.message, headers);
      return;
    }
    headers["x-chainaim-data-class"] = result.record.dataClass ?? "none";
    headers["x-chainaim-classifier"] = result.record.classifier ?? "rules";
    headers["x-chainaim-model"] = result.record.served ?? "";
    if (!result.stream) {
      sendJson(res, 200, result.completion, headers);
      return;
    }
    const text = toSse(result.completion);
    res.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  async function explain(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const decisionId = randomUUID();
    const { attempts: _attempts, ...decision } = await explainChat(await readJson(req, opts.maxBodyBytes), deps);
    sendJson(res, 200, { decisionId, decision }, { "x-chainaim-decision-id": decisionId });
  }

  const models = () => ({
    object: "list",
    data: [
      { id: "chainaim/auto", object: "model", owned_by: "chainaim" },
      ...deps.source.models().map((m) => ({ id: m.id, object: "model", owned_by: m.id.split("/")[0], context_length: m.contextLength, supports_tools: m.tools })),
    ],
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /healthz") {
        // Unauthenticated: says only whether Presidio answered its last check.
        sendJson(res, presidio.healthy ? 200 : 503, { status: presidio.healthy ? "ok" : "privacy_scanner_unavailable" });
        return;
      }
      if (!authorized(req, opts.gatewayKey)) {
        sendError(res, 401, "missing or invalid gateway API key");
        return;
      }
      if (route === "POST /v1/privacy/scan") await privacy("scan", req, res);
      else if (route === "POST /v1/privacy/mask") await privacy("mask", req, res);
      else if (route === "POST /v1/chat/completions") await chat(req, res);
      else if (route === "POST /v1/route/explain") await explain(req, res);
      else if (route === "GET /v1/models") sendJson(res, 200, models());
      else if (route === "GET /internal/capacity") sendJson(res, 200, deps.quota.capacity(deps.source.ready()));
      else if (route === "GET /v1/deployments") sendJson(res, 200, { unavailableModels: deps.pool.unavailableModels(), deployments: deps.pool.status() });
      else sendError(res, 404, `no route for ${route}`);
    } catch (e) {
      if (e instanceof HttpError) sendError(res, e.status, e.message, e.headers);
      else {
        console.error(`[chainaim-gateway] ${route}:`, e);
        sendError(res, 500, "internal gateway error");
      }
    }
  });
}
```

- [ ] **Step 7: Replace the entry point**

Replace `services/gateway/src/main.ts` with:

```ts
/**
 * chainaim-gateway: entry point.
 *
 *   node services/gateway/src/main.ts [flags]
 *
 * Every behaviour is a flag with a default; nothing is hard-coded elsewhere.
 */
import { parseArgs } from "node:util";
import { loadCatalog } from "./catalog.ts";
import { Ledger } from "./ledger.ts";
import { Pool } from "./pool.ts";
import { PresidioClient, waitForPresidio } from "./privacy/presidio.ts";
import { catalogSource, FreePool, openRouterDeployments, type ModelSource } from "./routing/freepool.ts";
import { JevClient } from "./routing/jev.ts";
import { Quota } from "./routing/quota.ts";
import { loadScoreTable } from "./routing/scores.ts";
import { ExpiringSet } from "./routing/select.ts";
import { createGateway } from "./server.ts";

const USAGE = `chainaim-gateway [flags]

  --model-source catalog|openrouter-free  chat models: catalog (tests, local) or OpenRouter free (default catalog)
  --catalog PATH             model catalog JSON, catalog mode            (default config/catalog.json)
  --scores PATH              free-model scoring table                    (default config/free-models.json)
  --host HOST                bind address                                (default 127.0.0.1)
  --port N                   listen port                                 (default 8700)
  --max-output-tokens N      cap and default for max_tokens              (default 1024)
  --max-attempts N           model attempts per chat request             (default 3)
  --attempt-timeout-ms N     one model attempt, whole answer             (default 60000)
  --health-interval-ms N     catalog deployment probe period, 0 = off    (default 10000)
  --health-timeout-ms N      per-probe timeout                           (default 3000)
  --unhealthy-after N        consecutive failures before cooldown        (default 2)
  --cooldown-ms N            how long a failed deployment sits out       (default 30000)
  --presidio-url URL         Presidio analyzer                           (default http://127.0.0.1:5002)
  --presidio-threshold N     minimum entity score, 0 to 1                (default 0.4)
  --presidio-timeout-ms N    per Presidio call                           (default 10000)
  --presidio-wait-ms N       how long start-up waits for Presidio        (default 120000)
  --presidio-check-ms N      Presidio health check period                (default 30000)
  --openrouter-base-url URL  OpenRouter API root                         (default https://openrouter.ai)
  --openrouter-key-env NAME  env var holding the OpenRouter key          (default OPENROUTER_API_KEY)
  --jev on|off               classify chat requests with Jev             (default on)
  --jev-model ID             Decisions API model                         (default typesafe/jev-1.13)
  --jev-timeout-ms N         Jev call timeout                            (default 800)
  --health-flag-threshold N  Jev health probability that makes PHI       (default 0.5)
  --free-sync-interval-ms N  free model list refresh                     (default 21600000)
  --free-rpm N               free-model calls per 60 s window            (default 20)
  --deny-cache-ms N          skip a model with no no-collection provider (default 21600000)
  --key-read-interval-ms N   OpenRouter key allowance read period        (default 600000)
  --ledger DIR|off           decision ledger directory                   (default data/ledger)
  --max-body-bytes N         request size limit                          (default 4194304)
  --api-key-env NAME         env var holding the gateway bearer key      (default none = no auth)
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

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const OPTIONS = {
  "model-source": { type: "string", default: "catalog" },
  catalog: { type: "string", default: "config/catalog.json" },
  scores: { type: "string", default: "config/free-models.json" },
  host: { type: "string", default: "127.0.0.1" },
  port: { type: "string", default: "8700" },
  "max-output-tokens": { type: "string", default: "1024" },
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
  "openrouter-base-url": { type: "string", default: "https://openrouter.ai" },
  "openrouter-key-env": { type: "string", default: "OPENROUTER_API_KEY" },
  jev: { type: "string", default: "on" },
  "jev-model": { type: "string", default: "typesafe/jev-1.13" },
  "jev-timeout-ms": { type: "string", default: "800" },
  "health-flag-threshold": { type: "string", default: "0.5" },
  "free-sync-interval-ms": { type: "string", default: "21600000" },
  "free-rpm": { type: "string", default: "20" },
  "deny-cache-ms": { type: "string", default: "21600000" },
  "key-read-interval-ms": { type: "string", default: "600000" },
  ledger: { type: "string", default: "data/ledger" },
  "max-body-bytes": { type: "string", default: String(4 * 1024 * 1024) },
  "api-key-env": { type: "string" },
  help: { type: "boolean", default: false },
} as const;

export function parseFlags(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, strict: true, options: OPTIONS });
  const source = v["model-source"]!;
  if (source !== "catalog" && source !== "openrouter-free") throw new Error("--model-source must be catalog or openrouter-free");
  if (v.jev !== "on" && v.jev !== "off") throw new Error("--jev must be on or off");
  if (!ENV_NAME.test(v["openrouter-key-env"]!)) throw new Error("--openrouter-key-env must be an environment variable NAME, not a key");
  for (const name of ["presidio-url", "openrouter-base-url"] as const) {
    if (!URL.canParse(v[name]!)) throw new Error(`--${name} must be a URL`);
  }
  return {
    help: v.help!,
    modelSource: source as "catalog" | "openrouter-free",
    catalog: v.catalog!,
    scores: v.scores!,
    host: v.host!,
    port: int("port", v.port!, 0),
    maxOutputTokens: int("max-output-tokens", v["max-output-tokens"]!, 1),
    maxAttempts: int("max-attempts", v["max-attempts"]!, 1),
    attemptTimeoutMs: int("attempt-timeout-ms", v["attempt-timeout-ms"]!, 1),
    healthIntervalMs: int("health-interval-ms", v["health-interval-ms"]!, 0),
    healthTimeoutMs: int("health-timeout-ms", v["health-timeout-ms"]!, 1),
    unhealthyAfter: int("unhealthy-after", v["unhealthy-after"]!, 1),
    cooldownMs: int("cooldown-ms", v["cooldown-ms"]!, 0),
    presidioUrl: v["presidio-url"]!,
    presidioThreshold: num("presidio-threshold", v["presidio-threshold"]!, 0, 1),
    presidioTimeoutMs: int("presidio-timeout-ms", v["presidio-timeout-ms"]!, 1),
    presidioWaitMs: int("presidio-wait-ms", v["presidio-wait-ms"]!, 0),
    presidioCheckMs: int("presidio-check-ms", v["presidio-check-ms"]!, 0),
    openRouterBaseUrl: v["openrouter-base-url"]!.replace(/\/+$/, ""),
    openRouterKeyEnv: v["openrouter-key-env"]!,
    jev: v.jev === "on",
    jevModel: v["jev-model"]!,
    jevTimeoutMs: int("jev-timeout-ms", v["jev-timeout-ms"]!, 1),
    healthFlagThreshold: num("health-flag-threshold", v["health-flag-threshold"]!, 0, 1),
    freeSyncIntervalMs: int("free-sync-interval-ms", v["free-sync-interval-ms"]!, 0),
    freeRpm: int("free-rpm", v["free-rpm"]!, 1),
    denyCacheMs: int("deny-cache-ms", v["deny-cache-ms"]!, 0),
    keyReadIntervalMs: int("key-read-interval-ms", v["key-read-interval-ms"]!, 0),
    ledgerDir: v.ledger === "off" ? undefined : v.ledger!,
    maxBodyBytes: int("max-body-bytes", v["max-body-bytes"]!, 1024),
    apiKeyEnv: v["api-key-env"],
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
  const openRouterKey = process.env[f.openRouterKeyEnv] || undefined;

  // Refuse to start without a Presidio that detects every required entity (V4).
  const presidio = new PresidioClient({ url: f.presidioUrl, threshold: f.presidioThreshold, timeoutMs: f.presidioTimeoutMs });
  await waitForPresidio(presidio, f.presidioWaitMs);
  presidio.start(f.presidioCheckMs);

  const table = loadScoreTable(f.scores);
  const pool = new Pool({ healthIntervalMs: f.healthIntervalMs, healthTimeoutMs: f.healthTimeoutMs, unhealthyAfter: f.unhealthyAfter, cooldownMs: f.cooldownMs, env: process.env });
  let source: ModelSource;
  let freePool: FreePool | undefined;
  if (f.modelSource === "catalog") {
    const catalog = loadCatalog(f.catalog);
    pool.setModels(catalog.models);
    source = catalogSource(catalog);
    await pool.checkAll();
    pool.start();
  } else if (!openRouterKey) {
    // Scan and mask never need OpenRouter, so a missing key must not take them down (spec section 13).
    console.error(`[chainaim-gateway] ${f.openRouterKeyEnv} is not set: chat is unavailable; scan and mask work`);
    source = { models: () => [], ready: () => false };
  } else {
    freePool = new FreePool({
      baseUrl: f.openRouterBaseUrl,
      intervalMs: f.freeSyncIntervalMs,
      timeoutMs: 15_000,
      onChange: (models) => pool.setModels(openRouterDeployments(models, f.openRouterBaseUrl, f.openRouterKeyEnv)),
    });
    if (!(await freePool.sync())) console.error("[chainaim-gateway] the free model sync failed; chat has no capacity until one succeeds");
    freePool.start();
    source = freePool;
  }
  const keyReader = f.modelSource === "openrouter-free" && openRouterKey ? { keyUrl: `${f.openRouterBaseUrl}/api/v1/key`, apiKey: openRouterKey } : {};
  const quota = new Quota({ rpm: f.freeRpm, keyIntervalMs: f.keyReadIntervalMs, ...keyReader });
  await quota.refresh();
  quota.start();
  const jev = f.jev && openRouterKey ? new JevClient({ baseUrl: f.openRouterBaseUrl, apiKey: openRouterKey, model: f.jevModel, timeoutMs: f.jevTimeoutMs }) : undefined;
  const ledger = new Ledger(f.ledgerDir);

  const server = createGateway(
    {
      presidio,
      pool,
      source,
      table,
      quota,
      deny: new ExpiringSet(f.denyCacheMs),
      jev,
      ledger,
      chat: { maxOutputTokens: f.maxOutputTokens, maxAttempts: f.maxAttempts, attemptTimeoutMs: f.attemptTimeoutMs, healthFlagThreshold: f.healthFlagThreshold },
    },
    { maxBodyBytes: f.maxBodyBytes, gatewayKey },
  );
  server.listen(f.port, f.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : f.port;
    console.log(
      `[chainaim-gateway] listening on http://${f.host}:${port}  source=${f.modelSource} models=${source.models().length} ` +
        `jev=${jev ? "on" : "off"} presidio=${presidio.url} ledger=${ledger.enabled ? f.ledgerDir : "off"} auth=${gatewayKey ? "on" : "off"}`,
    );
  });
  const shutdown = () => {
    pool.stop();
    freePool?.stop();
    quota.stop();
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

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS for every file, 0 failures, and the run exits by itself. `grep -rn "engine.ts\|RequestError\|PROFILE_PREFIX" services/gateway` finds nothing.

- [ ] **Step 9: Run the production wiring against the stubs**

This proves `main.ts` in `openrouter-free` mode end to end, with nothing real involved (the key is a dummy the stub accepts). Use three terminals, from the repo root:

```bash
npm run stub-presidio
```

```bash
npm run stub-openrouter
```

```bash
OR_DUMMY=sk-or-dummy node services/gateway/src/main.ts --model-source openrouter-free --openrouter-base-url http://127.0.0.1:5003 --openrouter-key-env OR_DUMMY --port 8791 --ledger off
```

Then:

```bash
curl -s http://127.0.0.1:8791/internal/capacity
curl -s -X POST http://127.0.0.1:8791/v1/chat/completions -H "content-type: application/json" -d '{"messages":[{"role":"user","content":"Remind Jane Roe about Friday."}]}'
```

Expected: `{"chatAvailable":true}`, then a completion whose content is `echo: Remind Jane Roe about Friday.`, served by a `stub/...:free` model (the stub OpenRouter saw only `<PERSON_1>`). Stop all three processes, and put the output in the report.

- [ ] **Step 10: Commit**

```bash
git add services/gateway/src/chat.ts services/gateway/src/server.ts services/gateway/src/ledger.ts services/gateway/src/dispatch.ts services/gateway/src/main.ts services/gateway/test/helpers.ts services/gateway/test/gateway.test.ts services/gateway/test/chat.test.ts
git rm services/gateway/src/engine.ts
git commit -m "feat(chat): private chat pipeline over free models, new routes and start-up wiring; retire routing profiles" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**The launch gate passes when** `chat.test.ts`'s first suite passes. Its three checks are spec section 11 items 1 to 3.

---

### Task C10: Production start command, smoke test and the documents

**Files:**
- Modify: `services/gateway/Dockerfile` (the start command)
- Modify: `scripts/smoke.ts` (replace the whole file)
- Modify: `README.md` (replace the whole file), `DEMO.md` (a note at the top), `PROJECT_CONTEXT.md` (replace the whole file), `docs/deploy/railway.md` (step 7)
- Create: `docs/adr/0002-openrouter-free-models-and-jev.md`, `docs/submission.md`

**Interfaces:**
- Consumes: the gateway's flags (C9) and routes; the paywall (Part B).
- Produces: documents only, plus the smoke script `node scripts/smoke.ts [--gateway URL] [--api-key-env NAME] [--chat]`.

Spec section 14 lists the follow-up documents. The submission text must match what is live; the draft says which lines to check before submitting.

- [ ] **Step 1: Switch the gateway image to the free pool**

In `services/gateway/Dockerfile`, replace the `CMD` line with:

```dockerfile
CMD ["--host", "::", "--port", "8700", "--api-key-env", "CHAINAIM_GATEWAY_KEY", "--model-source", "openrouter-free", "--presidio-url", "http://presidio.railway.internal:3000", "--ledger", "/data/ledger"]
```

Without `OPENROUTER_API_KEY` the gateway still starts, and scan and mask work; chat reports no capacity (see `main.ts`).

In `docs/deploy/railway.md`, replace the paragraph under "## 7. When chat launches" with:

```markdown
The gateway image runs with `--model-source openrouter-free`. Until `OPENROUTER_API_KEY` is set on the gateway, chat reports no capacity and the paywall refuses chat calls without charging; scan and mask are unaffected. To launch chat: buy $10 of OpenRouter credits (1,000 free-model requests a day), add `OPENROUTER_API_KEY` to the gateway, redeploy it, and run `npm run verify:openrouter` from your PC with the same key (V1, V2 and V5). Then make one real MainNet payment on chat.
```

- [ ] **Step 2: Replace the smoke test**

Replace `scripts/smoke.ts` with:

```ts
/**
 * Smoke-test a running chainaim-gateway.
 *
 *   node scripts/smoke.ts [--gateway http://127.0.0.1:8700] [--api-key-env NAME] [--chat]
 *
 * Checks liveness, the model list, scan and mask on synthetic text, and with
 * --chat one private chat call. Works against the stub Presidio or a real one.
 * Exit code 0 = all checks passed.
 */
import { parseArgs } from "node:util";

const { values: f } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8700" },
    "api-key-env": { type: "string" },
    chat: { type: "boolean", default: false },
    timeout: { type: "string", default: "120000" },
  },
});
const G = f.gateway!.replace(/\/+$/, "");
const key = f["api-key-env"] ? process.env[f["api-key-env"]] : undefined;
const timeoutMs = Number(f.timeout);
const TEXT = "Patient Jane Roe, MRN 991122, was diagnosed with diabetes."; // synthetic

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail: unknown): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `  ok   ${label}` : `  FAIL ${label}: ${JSON.stringify(detail)}`);
}
const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) });
const post = (path: string, body: unknown) => fetch(`${G}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });

console.log(`smoke: ${G}\n`);
const health = await fetch(`${G}/healthz`);
check("healthz is 200 (Presidio answers)", health.status === 200, health.status);
const models = await (await fetch(`${G}/v1/models`, { headers: headers() })).json();
check("the model list starts with chainaim/auto", models.data?.[0]?.id === "chainaim/auto", models.data?.[0]);
const scan = await (await post("/v1/privacy/scan", { text: TEXT })).json();
check("scan says PHI with a no-collection policy", scan.dataClass === "PHI" && scan.policy?.dataCollection === "deny", scan.dataClass);
const mask = await (await post("/v1/privacy/mask", { text: TEXT })).json();
check("mask hides the name", typeof mask.maskedText === "string" && !mask.maskedText.includes("Jane Roe"), mask.maskedText);
check("mask's map holds the name", Object.values(mask.map ?? {}).includes("Jane Roe"), mask.map);
if (f.chat) {
  const r = await post("/v1/chat/completions", { messages: [{ role: "user", content: "Say hello to Jane Roe in five words." }], max_tokens: 64 });
  const j = await r.json();
  check("chat answers 200", r.status === 200, j.error ?? r.status);
  check("chat names the model that served it", (r.headers.get("x-chainaim-model") ?? "") !== "", r.headers.get("x-chainaim-model"));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
```

- [ ] **Step 3: Rewrite the README**

Replace `README.md` with:

````markdown
# chainaim-router

ChainAim's privacy gateway for AI agents. Agents pay per call in USDC on Algorand (x402) for three services: find personal, health and card data in text (**scan**), replace it with placeholders they can restore (**mask**), and an OpenAI-compatible **private chat** that masks the conversation before any model sees it.

```
agent ──HTTPS──▶ paywall (public, x402) ──private network──▶ gateway ──▶ OpenRouter free models (chat)
                   │                                           ├──▶ OpenRouter Decisions API (Jev)
                   └──▶ GoPlausible facilitator                └──▶ Presidio analyzer (private)
```

Design: `docs/superpowers/specs/2026-09-24-privacy-gateway-design.md`. Deployment: `docs/deploy/railway.md`. Decisions: `docs/adr/`.

## Paid endpoints (the paywall)

| Method | Path | Price | What it does |
| --- | --- | --- | --- |
| POST | /v1/privacy/scan | $0.002 | Entities (type, UTF-16 start/end, score), classes (PHI, PCI, PII) and the data policy. No model is called. |
| POST | /v1/privacy/mask | $0.003 | Masked text (`<PERSON_1>`, `[CARD REMOVED]`), the map to restore it, counts |
| POST | /v1/chat/completions | $0.01 | Private chat: mask, classify with Jev, route across free models, restore the answer |
| GET | /v1/models, /healthz | free | The model list; liveness |

Every refusal (4xx, 5xx) is free: the payment settles only when the gateway answers below 400. Chat asks for payment only when it can be served. Health data only goes to model providers that don't collect data; if none is available, the request is refused and not charged.

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

Presidio runs on the private network, and nothing leaves until the text is masked; if Presidio is down, everything answers 503. The decision ledger never holds text, placeholders or the map. Payment headers are stripped before the gateway, so it never learns who paid. Only allowlisted request fields reach a model, so a client can't override the data policy or pass unscanned text.
````

- [ ] **Step 4: Mark the old demo runbook**

At the top of `DEMO.md`, directly under the title line, add:

```markdown
> **Iteration 0 runbook.** This describes the routing-profile demo over two local models. Since the privacy gateway (September 2026), chat always masks first and routes across OpenRouter's free models; `chainaim/eco` and `chainaim/premium` are retired, and the profile steps below no longer apply. For the current system see `README.md`.
```

- [ ] **Step 5: Update the project context and record the decisions**

Replace `PROJECT_CONTEXT.md` with:

```markdown
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
```

Create `docs/adr/0002-openrouter-free-models-and-jev.md`:

```markdown
# ADR 0002: OpenRouter free models, and Jev for classification

Date: 2026-09-25 · Status: accepted

## Decision
- **D2.** Every chat answer comes from an OpenRouter free model (id ends in `:free`). No self-hosted or other hosted models in production.
- **D3.** The paid chat endpoint uses those free models without asking OpenRouter first.
- **D9.** Jev never sees a request already classed as health data (PHI); the route engine's rules classify those.

## Why
- D2: API keys only, no inference on hardware ChainAim runs; the service must be up around the clock through October on a managed container platform without a GPU.
- D3: the owner accepts the risk under section 7 of OpenRouter's terms (reselling API access to models). Mitigations: scan and mask never use OpenRouter; chat refuses without charging when the key stops working; the paywall's capacity guard stops payment requests for chat when it cannot be served.
- D9: health text only goes to providers that don't collect data, and TypeSafe has not published a retention policy for Jev.

## Consequences
- Chat volume is capped by OpenRouter's free limits: 20 requests a minute, and 1,000 a day once $10 of credits are bought. Scan and mask carry most of the volume.
- Health-data chat is refused, without charge, whenever no free model has a provider that doesn't collect data. The ledger counts these refusals.
- If OpenRouter suspends the key, chat is unavailable; scan and mask continue.
- The free lineup changes: the pool is re-synced every 6 hours, and unlisted models are scored from the size in their id.
```

Create `docs/submission.md`:

```markdown
# Submission draft: Global x402 Challenge (Composite entry)

> Before submitting, check every line against what is live: each route listed in the Bazaar, and each route with a real MainNet payment. Delete any sentence that is not yet true. If chat is not live on September 29, describe it as launching.

**Name.** ChainAim Privacy Gateway

**One line.** Pay-per-call privacy for AI agents on Algorand: find and mask personal, health and card data, and chat with models that never see the originals.

**What it does.** Three x402 endpoints on one payTo address, paid in USDC on Algorand MainNet through the GoPlausible facilitator, and listed in the Bazaar with the tag `x402-global-challenge`:

- **scan** ($0.002): finds personal, health and card data in a text and returns the entity types, positions, data class and data policy. No model is called.
- **mask** ($0.003): replaces personal and health identifiers with numbered placeholders, removes card numbers, and returns the map to restore them.
- **chat** ($0.01): an OpenAI-compatible chat. The conversation is masked before any model sees it. TypeSafe's Jev (through OpenRouter's Decisions API) classifies the masked request, a scoring table picks among OpenRouter's free models, and the original values are put back into the answer.

**Privacy.**
- Detection runs on a Presidio analyzer inside ChainAim's private network. Raw text is never sent anywhere before it is masked, and if the scanner is down, every call is refused.
- Health data only goes to model providers that don't collect data. If none is available, the request is refused and the caller isn't charged.
- Card numbers are removed, never restored.
- The decision ledger records classes and counts, never text.
- The paywall strips payment headers, so the gateway never learns who paid.

**Why x402 is core.** Every call is a paid request with no accounts and no API keys: an agent discovers the service in the Bazaar and pays per call. Settlement happens only after a successful answer, so refusals are free.

**Honest limits.** Detection is automated and can miss values: recall is being measured on a synthetic set, and no compliance certification is claimed. Chat runs on free models with OpenRouter's rate limits, so capacity is limited; the paywall only asks for payment when chat can be served.

**Links.** Repository: https://github.com/chainaimdev/chainaim-router · Endpoint: https://PAYWALL-DOMAIN (fill in after deployment)
```

- [ ] **Step 6: Check it end to end and commit**

Run: `npm test` and `npm run test:paywall`. Both must PASS.

Then, with the stubs and the gateway running as in Task C9 Step 9 (gateway on port 8791), run `node scripts/smoke.ts --gateway http://127.0.0.1:8791 --chat`.
Expected: `7 passed, 0 failed`. Stop the processes.

```bash
git add services/gateway/Dockerfile scripts/smoke.ts README.md DEMO.md PROJECT_CONTEXT.md docs/deploy/railway.md docs/adr/0002-openrouter-free-models-and-jev.md docs/submission.md
git commit -m "docs: README, project context, ADR 0002, submission draft; gateway image runs the free pool" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Milestone C done when** `npm test` and `npm run test:paywall` pass, including the launch gate. Then the owner adds the OpenRouter key and credits, redeploys the gateway, runs `npm run verify:openrouter`, and makes a real MainNet payment on chat (docs/deploy/railway.md step 7).
