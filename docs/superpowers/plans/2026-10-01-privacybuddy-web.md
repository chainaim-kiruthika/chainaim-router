# PrivacyBuddy web: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web page where a person types a private message, sees it masked on their own device, then clicks Execute to pay (USDC, x402) and get the model's answer with the original values put back; the page shows the buyer and pay-to wallets top right under the slogan "Spend your tokens wisely".

**Architecture:** A new small service `services/web` (Hono on Node, no build step) serves the page and two JSON endpoints. The browser masks with the existing `client-mask.ts` (served to the browser as JavaScript). `/api/execute` receives only masked text, re-checks it, pays the paywall's chat route from a demo buyer wallet held in an environment variable, and returns the answer plus the payment receipt.

**Tech Stack:** Node 24 (runs TypeScript directly, no build), Hono 4.13.9, @hono/node-server 2.1.1, @x402/fetch + @x402/avm 2.27.0, algokit-utils 10.0.0-alpha.42, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-01-privacybuddy-web-design.md`

## Global Constraints

- Node runs `.ts` files directly: erasable TypeScript only (no enums, no parameter properties, no namespaces); imports use the `.ts` extension.
- No build step, no bundler, no external fonts or scripts on the page; system fonts only.
- The server never logs, stores or returns submitted text, placeholders or the restore map; logs hold status, sizes and timing only.
- The buyer key (`BUYER_MNEMONIC`) is read once in `main.ts`, removed from `process.env`, and never logged or returned; only the public address is exposed.
- Model output is untrusted: the page builds it with text nodes only, never `innerHTML`.
- Defaults: `PORT` 8740, `HOST` 127.0.0.1, `RATE_PER_MINUTE` 5, `MAX_EXECUTES_PER_HOUR` 30, chat limit 48,000 characters of masked text, `maxTokens` 1 to 1024 (default 512).
- Slogan text exactly: "Spend your tokens wisely". Product name: "PrivacyBuddy".
- Commits: the owner decides when to commit. Steps below end with a checkpoint (run the tests), not a commit. Do not commit unless the owner asks.

## File Structure

```
services/web/
  package.json            dependencies and scripts
  README.md               how to run it
  src/config.ts           environment variables, validated
  src/limits.ts           per-visitor rate limit and hourly spend cap
  src/mask.ts             the one place that knows where client-mask.ts lives; browser JavaScript + server-side detect
  src/wallets.ts          read the paywall's 402 quote; read a wallet's balance
  src/buyer.ts            the x402 payer built from BUYER_MNEMONIC
  src/app.ts              createWebApp(deps): all routes
  src/main.ts             start-up
  public/index.html       the page (HTML, CSS and script in one file)
  test/config.test.ts
  test/limits.test.ts
  test/mask.test.ts
  test/wallets.test.ts
  test/buyer.test.ts
  test/app.test.ts
  test/main.test.ts
```

Helper used by the executor to write files from this plan: every file block is introduced by a line
`**Create \`path\`:**` and fenced with four backticks.

---

### Task 1: Scaffold and configuration

**Files:**
- Create: `services/web/package.json`
- Create: `services/web/src/config.ts`
- Test: `services/web/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): WebConfig` where `WebConfig = { port: number; host: string; paywallUrl: string; ratePerMinute: number; maxExecutesPerHour: number }`.

- [ ] **Step 1: Create the package file**

**Create `services/web/package.json`:**

````json
{
  "name": "@chainaim/web",
  "version": "0.1.0",
  "private": true,
  "description": "PrivacyBuddy: a web page for private chat, masked on the device and paid per answer with x402.",
  "type": "module",
  "engines": {
    "node": ">=22.22"
  },
  "scripts": {
    "start": "node src/main.ts",
    "test": "node --test --test-force-exit \"test/*.test.ts\""
  },
  "dependencies": {
    "@algorandfoundation/algokit-utils": "10.0.0-alpha.42",
    "@hono/node-server": "2.1.1",
    "@x402/avm": "2.27.0",
    "@x402/core": "2.27.0",
    "@x402/fetch": "2.27.0",
    "hono": "4.13.9"
  }
}
````

- [ ] **Step 2: Install**

Run: `npm --prefix services/web install`
Expected: installs without errors and creates `services/web/node_modules` and `services/web/package-lock.json`.

- [ ] **Step 3: Write the failing test**

**Create `services/web/test/config.test.ts`:**

````ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("needs PAYWALL_URL", () => {
    assert.throws(() => loadConfig({}), /PAYWALL_URL/);
  });

  it("rejects a PAYWALL_URL that is not http(s)", () => {
    assert.throws(() => loadConfig({ PAYWALL_URL: "ftp://example.com" }), /PAYWALL_URL/);
  });

  it("applies the defaults and trims a trailing slash", () => {
    assert.deepEqual(loadConfig({ PAYWALL_URL: "http://127.0.0.1:8080/" }), {
      port: 8740,
      host: "127.0.0.1",
      paywallUrl: "http://127.0.0.1:8080",
      ratePerMinute: 5,
      maxExecutesPerHour: 30,
    });
  });

  it("reads overrides", () => {
    const c = loadConfig({ PAYWALL_URL: "https://paywall.example", PORT: "9000", HOST: "0.0.0.0", RATE_PER_MINUTE: "2", MAX_EXECUTES_PER_HOUR: "10" });
    assert.deepEqual([c.port, c.host, c.ratePerMinute, c.maxExecutesPerHour], [9000, "0.0.0.0", 2, 10]);
  });

  it("rejects a number out of range", () => {
    assert.throws(() => loadConfig({ PAYWALL_URL: "http://x.test", RATE_PER_MINUTE: "0" }), /RATE_PER_MINUTE/);
    assert.throws(() => loadConfig({ PAYWALL_URL: "http://x.test", PORT: "abc" }), /PORT/);
  });
});
````

- [ ] **Step 4: Run it to see it fail**

Run: `node --test services/web/test/config.test.ts`
Expected: FAIL, cannot find `../src/config.ts`.

- [ ] **Step 5: Implement**

**Create `services/web/src/config.ts`:**

````ts
/**
 * Configuration from the environment. BUYER_MNEMONIC is read in main.ts and
 * never passes through this module, so it cannot end up in an error message.
 */
export type WebConfig = {
  port: number;
  host: string;
  paywallUrl: string;
  ratePerMinute: number;
  maxExecutesPerHour: number;
};

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${raw}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): WebConfig {
  const paywallUrl = (env.PAYWALL_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(paywallUrl) || !URL.canParse(paywallUrl)) {
    throw new Error("PAYWALL_URL must be the paywall's http(s) address, for example http://127.0.0.1:8080");
  }
  return {
    port: integer(env, "PORT", 8740, 1, 65535),
    host: env.HOST?.trim() || "127.0.0.1",
    paywallUrl,
    ratePerMinute: integer(env, "RATE_PER_MINUTE", 5, 1, 1000),
    maxExecutesPerHour: integer(env, "MAX_EXECUTES_PER_HOUR", 30, 1, 100000),
  };
}
````

- [ ] **Step 6: Run it to see it pass**

Run: `node --test services/web/test/config.test.ts`
Expected: PASS, 5 tests.

---

### Task 2: Limits

**Files:**
- Create: `services/web/src/limits.ts`
- Test: `services/web/test/limits.test.ts`

**Interfaces:**
- Produces: `class Limits { constructor(perMinute: number, perHour: number, now?: () => number); take(visitor: string): "visitor" | "hour" | undefined }` and `type LimitReason = "visitor" | "hour"`.

- [ ] **Step 1: Write the failing test**

**Create `services/web/test/limits.test.ts`:**

````ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Limits } from "../src/limits.ts";

describe("Limits", () => {
  it("allows up to the per-minute count for one visitor, then refuses", () => {
    let t = 0;
    const l = new Limits(2, 100, () => t);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("a"), "visitor");
  });

  it("does not let one visitor use up another's minute", () => {
    const l = new Limits(1, 100, () => 0);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("b"), undefined);
    assert.equal(l.take("a"), "visitor");
  });

  it("frees the visitor after a minute", () => {
    let t = 0;
    const l = new Limits(1, 100, () => t);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("a"), "visitor");
    t = 60_001;
    assert.equal(l.take("a"), undefined);
  });

  it("caps all visitors together per hour, then frees after an hour", () => {
    let t = 0;
    const l = new Limits(100, 3, () => t);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("b"), undefined);
    assert.equal(l.take("c"), undefined);
    assert.equal(l.take("d"), "hour");
    t = 3_600_001;
    assert.equal(l.take("d"), undefined);
  });

  it("does not record a refused attempt against the hour", () => {
    const l = new Limits(1, 2, () => 0);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("a"), "visitor");
    assert.equal(l.take("b"), undefined);
    assert.equal(l.take("c"), "hour");
  });
});
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test services/web/test/limits.test.ts`
Expected: FAIL, cannot find `../src/limits.ts`.

- [ ] **Step 3: Implement**

**Create `services/web/src/limits.ts`:**

````ts
/**
 * In-memory limits for the demo page: executes per visitor per minute, and
 * executes across all visitors per hour. The hourly cap bounds what the demo
 * buyer wallet can spend. Both reset when the process restarts.
 */
export type LimitReason = "visitor" | "hour";

const MINUTE = 60_000;
const HOUR = 3_600_000;

export class Limits {
  private readonly visitors = new Map<string, number[]>();
  private hour: number[] = [];
  private readonly perMinute: number;
  private readonly perHour: number;
  private readonly now: () => number;

  constructor(perMinute: number, perHour: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.perHour = perHour;
    this.now = now;
  }

  /** undefined when the execute is allowed (and recorded); otherwise which limit was hit. */
  take(visitor: string): LimitReason | undefined {
    const t = this.now();
    this.hour = this.hour.filter((at) => t - at < HOUR);
    const mine = (this.visitors.get(visitor) ?? []).filter((at) => t - at < MINUTE);
    if (mine.length >= this.perMinute) {
      this.visitors.set(visitor, mine);
      return "visitor";
    }
    if (this.hour.length >= this.perHour) {
      this.visitors.set(visitor, mine);
      return "hour";
    }
    mine.push(t);
    this.visitors.set(visitor, mine);
    this.hour.push(t);
    if (this.visitors.size > 10_000) {
      for (const [key, times] of this.visitors) if (times.every((at) => t - at >= MINUTE)) this.visitors.delete(key);
    }
    return undefined;
  }
}
````

- [ ] **Step 4: Run it to see it pass**

Run: `node --test services/web/test/limits.test.ts`
Expected: PASS, 5 tests.

---

### Task 3: The masking module for the browser and the server

**Files:**
- Create: `services/web/src/mask.ts`
- Test: `services/web/test/mask.test.ts`

**Interfaces:**
- Consumes: `services/paywall/scripts/client-mask.ts` exports `detect(text, options?) => Found[]`, `maskText(text, options?) => { masked, map, counts, cardsRemoved }`, `restore(text, map) => { text, unresolved }`.
- Produces: `detect` (re-exported) and `browserMaskModule(): string` (client-mask.ts as browser JavaScript).

- [ ] **Step 1: Write the failing test**

**Create `services/web/test/mask.test.ts`:**

````ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserMaskModule, detect } from "../src/mask.ts";

/** The message the page's "Try an example" button fills in. Keep in step with public/index.html. */
export const EXAMPLE = "Name: Priya Raman\nEmail: priya.raman@example.com\nPhone: +91 98765 43210\nPAN: AJZPR4821K\n\nPlease write a short, polite email asking my landlord to refund my security deposit of INR 50,000.";

async function load() {
  return import("data:text/javascript;base64," + Buffer.from(browserMaskModule()).toString("base64"));
}

describe("the masking module", () => {
  it("is JavaScript a browser can import, with the functions the page uses", async () => {
    const m = await load();
    for (const name of ["detect", "mask", "maskText", "restore", "CARD_REMOVED", "PREFIX"]) assert.ok(name in m, `${name} is exported`);
  });

  it("masks and restores a sample in the same way the server-side copy does", async () => {
    const m = await load();
    const r = m.maskText(EXAMPLE);
    assert.equal(detect(r.masked).length, 0, "nothing is left to mask");
    assert.equal(m.restore(r.masked, r.map).text, EXAMPLE);
  });

  it("the page's example message is fully masked", async () => {
    const m = await load();
    const r = m.maskText(EXAMPLE);
    for (const secret of ["Priya Raman", "priya.raman@example.com", "98765 43210", "AJZPR4821K"]) {
      assert.ok(!r.masked.includes(secret), `${secret} is masked`);
    }
  });

  it("the server-side detect finds a raw email and nothing in placeholders", () => {
    assert.ok(detect("write to priya.raman@example.com").length > 0);
    assert.equal(detect("write to <C_EMAIL_ADDRESS_1> and <C_PERSON_1>").length, 0);
  });
});
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test services/web/test/mask.test.ts`
Expected: FAIL, cannot find `../src/mask.ts`.

- [ ] **Step 3: Implement**

**Create `services/web/src/mask.ts`:**

````ts
/**
 * The one place that knows where client-mask.ts lives. The browser gets the
 * same source, converted to JavaScript by Node's own type stripping (no build
 * step); the server uses `detect` from it for the same self-check as
 * scripts/private-ask.ts.
 */
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

export { detect } from "../../paywall/scripts/client-mask.ts";

const SOURCE = new URL("../../paywall/scripts/client-mask.ts", import.meta.url);

/** client-mask.ts as a JavaScript module a browser can import. */
export function browserMaskModule(): string {
  return stripTypeScriptTypes(readFileSync(SOURCE, "utf8"));
}
````

- [ ] **Step 4: Run it to see it pass**

Run: `node --test services/web/test/mask.test.ts`
Expected: PASS, 4 tests. (An "ExperimentalWarning: stripTypeScriptTypes" line is normal.) If the restore assertion fails on the sample, change only the sample's wording, not the test's intent.

---

### Task 4: Reading the paywall's quote and a wallet's balance

**Files:**
- Create: `services/web/src/wallets.ts`
- Test: `services/web/test/wallets.test.ts`

**Interfaces:**
- Produces:
  - `type Quote = { payTo: string; network: string; asset: string; price: number }`
  - `type NetworkName = "testnet" | "mainnet" | "unknown"`
  - `type Balance = { algo: number; usdc: number; optedIn: boolean }`
  - `networkName(caip2: string): NetworkName`
  - `readQuote(paywallUrl: string, route: string, fetcher?: typeof fetch): Promise<Quote>`
  - `readBalance(address: string, network: "testnet" | "mainnet", asset: string, fetcher?: typeof fetch): Promise<Balance>`

- [ ] **Step 1: Write the failing test**

**Create `services/web/test/wallets.test.ts`:**

````ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { networkName, readBalance, readQuote } from "../src/wallets.ts";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAYTO = "EA7WASZQYXGGRSMGYQLRI6TR2PQCVDC42QULUT5N62UMYO4A6ADCJ6464M";

const header = (accepts: unknown) => Buffer.from(JSON.stringify({ accepts })).toString("base64");
const quoteFetch = (status: number, accepts?: unknown) => async () =>
  new Response("{}", { status, headers: accepts === undefined ? {} : { "payment-required": header(accepts) } });

describe("networkName", () => {
  it("recognises TestNet and MainNet by their genesis hashes", () => {
    assert.equal(networkName(TESTNET), "testnet");
    assert.equal(networkName("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="), "mainnet");
    assert.equal(networkName("eip155:8453"), "unknown");
  });
});

describe("readQuote", () => {
  it("reads the pay-to address, network, asset and the price in USDC", async () => {
    const q = await readQuote("http://paywall.test", "/v1/chat/completions", quoteFetch(402, [{ network: TESTNET, amount: "10000", asset: "10458941", payTo: PAYTO }]));
    assert.deepEqual(q, { payTo: PAYTO, network: TESTNET, asset: "10458941", price: 0.01 });
  });

  it("posts to the route it was given", async () => {
    let seen = "";
    await readQuote("http://paywall.test", "/v1/privacy/scan", async (input) => {
      seen = String(input);
      return new Response("{}", { status: 402, headers: { "payment-required": header([{ network: TESTNET, amount: "2000", asset: "1", payTo: PAYTO }]) } });
    });
    assert.equal(seen, "http://paywall.test/v1/privacy/scan");
  });

  it("fails clearly when the paywall does not quote a price", async () => {
    await assert.rejects(readQuote("http://paywall.test", "/x", quoteFetch(503)), /did not quote a price \(HTTP 503\)/);
  });

  it("fails clearly when the quote has the wrong shape", async () => {
    await assert.rejects(readQuote("http://paywall.test", "/x", quoteFetch(402, [{ network: TESTNET }])), /not in the expected shape/);
  });
});

describe("readBalance", () => {
  const node = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it("reads ALGO and the USDC held", async () => {
    const b = await readBalance("ADDR", "testnet", "10458941", node({ amount: 3_999_000, assets: [{ "asset-id": 10458941, amount: 2_500_000 }] }));
    assert.deepEqual(b, { algo: 3.999, usdc: 2.5, optedIn: true });
  });

  it("reports an account that has not opted in to the asset", async () => {
    const b = await readBalance("ADDR", "testnet", "10458941", node({ amount: 4_000_000, assets: [] }));
    assert.deepEqual(b, { algo: 4, usdc: 0, optedIn: false });
  });

  it("uses the node for the right network", async () => {
    let seen = "";
    await readBalance("ADDR", "mainnet", "31566704", async (input) => {
      seen = String(input);
      return new Response("{}");
    });
    assert.match(seen, /^https:\/\/mainnet-api\.algonode\.cloud\/v2\/accounts\/ADDR$/);
  });

  it("fails clearly when the node errors", async () => {
    await assert.rejects(readBalance("ADDR", "testnet", "1", node({}, 500)), /HTTP 500/);
  });
});
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test services/web/test/wallets.test.ts`
Expected: FAIL, cannot find `../src/wallets.ts`.

- [ ] **Step 3: Implement**

**Create `services/web/src/wallets.ts`:**

````ts
/**
 * Reads that feed the wallet chips: what the paywall asks for (pay-to address,
 * network, asset, price), taken from its own 402 quote, and what a wallet holds,
 * taken from a public Algorand node. Both are read-only.
 */
export type Quote = { payTo: string; network: string; asset: string; price: number };
export type NetworkName = "testnet" | "mainnet" | "unknown";
export type Balance = { algo: number; usdc: number; optedIn: boolean };

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const NODES = { testnet: "https://testnet-api.algonode.cloud", mainnet: "https://mainnet-api.algonode.cloud" } as const;

export function networkName(caip2: string): NetworkName {
  if (caip2 === TESTNET) return "testnet";
  if (caip2.startsWith("algorand:wGHE2Pw")) return "mainnet";
  return "unknown";
}

/** Ask a paid route for its price without paying: the paywall answers 402 with the quote in a header. */
export async function readQuote(paywallUrl: string, route: string, fetcher: typeof fetch = fetch): Promise<Quote> {
  const r = await fetcher(paywallUrl + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi", messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(8000),
  });
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) throw new Error(`the paywall did not quote a price (HTTP ${r.status})`);
  const accepts = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: Record<string, unknown>[] }).accepts?.[0];
  if (!accepts || typeof accepts.payTo !== "string" || typeof accepts.network !== "string" || accepts.asset === undefined || !Number.isFinite(Number(accepts.amount))) {
    throw new Error("the paywall's quote is not in the expected shape");
  }
  return { payTo: accepts.payTo, network: accepts.network, asset: String(accepts.asset), price: Number(accepts.amount) / 1e6 };
}

export async function readBalance(address: string, network: "testnet" | "mainnet", asset: string, fetcher: typeof fetch = fetch): Promise<Balance> {
  const r = await fetcher(`${NODES[network]}/v2/accounts/${address}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`the Algorand node answered HTTP ${r.status}`);
  const j = (await r.json()) as { amount?: number; assets?: { "asset-id": number; amount: number }[] };
  const held = (j.assets ?? []).find((a) => String(a["asset-id"]) === asset);
  return { algo: (j.amount ?? 0) / 1e6, usdc: held ? held.amount / 1e6 : 0, optedIn: held !== undefined };
}
````

- [ ] **Step 4: Run it to see it pass**

Run: `node --test services/web/test/wallets.test.ts`
Expected: PASS, 9 tests.

---

### Task 5: The buyer (x402 payer)

**Files:**
- Create: `services/web/src/buyer.ts`
- Test: `services/web/test/buyer.test.ts`

**Interfaces:**
- Produces:
  - `type Settlement = { success?: boolean; transaction?: string; network?: string }`
  - `type Payer = { address: string; fetchPaid(url: string, init: RequestInit): Promise<Response>; settlement(response: Response): Settlement | undefined }`
  - `createBuyer(mnemonic: string): Promise<Payer>`

- [ ] **Step 1: Write the failing test**

**Create `services/web/test/buyer.test.ts`:**

````ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { createBuyer } from "../src/buyer.ts";

describe("createBuyer", () => {
  const words = mnemonicFromSeed(new Uint8Array(randomBytes(32)));

  it("derives a valid Algorand address from the 25 words, without touching the network", async () => {
    const buyer = await createBuyer(words);
    assert.match(buyer.address, /^[A-Z2-7]{58}$/);
  });

  it("gives the same address for the same words", async () => {
    assert.equal((await createBuyer(words)).address, (await createBuyer(words)).address);
  });

  it("rejects words that are not a valid phrase", async () => {
    await assert.rejects(createBuyer("not a real phrase"));
  });

  it("returns undefined, not an error, for a response with no settlement header", async () => {
    const buyer = await createBuyer(words);
    assert.equal(buyer.settlement(new Response("{}")), undefined);
  });
});
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test services/web/test/buyer.test.ts`
Expected: FAIL, cannot find `../src/buyer.ts`.

- [ ] **Step 3: Implement**

**Create `services/web/src/buyer.ts`:**

````ts
/**
 * The demo buyer: an x402 payer built from the 25 words in BUYER_MNEMONIC.
 * The same set-up as scripts/pay.ts and scripts/private-ask.ts. The words are
 * used once to derive the signing key; only the public address leaves this file.
 */
export type Settlement = { success?: boolean; transaction?: string; network?: string };

export type Payer = {
  address: string;
  /** fetch that answers a 402 by signing and sending the payment. */
  fetchPaid: (url: string, init: RequestInit) => Promise<Response>;
  /** The payment receipt from a paid response, if it carries one. */
  settlement: (response: Response) => Settlement | undefined;
};

export async function createBuyer(mnemonic: string): Promise<Payer> {
  const { x402Client, wrapFetchWithPayment, x402HTTPClient } = await import("@x402/fetch");
  const { toClientAvmSigner } = await import("@x402/avm");
  const { ExactAvmScheme } = await import("@x402/avm/exact/client");
  const { seedFromMnemonic } = await import("@algorandfoundation/algokit-utils/algo25");
  const { ed25519SigningKeyFromWrappedSecret } = await import("@algorandfoundation/algokit-utils/crypto");

  const seed = seedFromMnemonic(mnemonic);
  const seedCopy = new Uint8Array(seed);
  const key = await ed25519SigningKeyFromWrappedSecret({ unwrapEd25519Seed: async () => seed, wrapEd25519Seed: async () => {} });
  const signer = toClientAvmSigner(Buffer.concat([Buffer.from(seedCopy), Buffer.from(key.ed25519Pubkey)]).toString("base64"));
  const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
  const paid = wrapFetchWithPayment(fetch, client);
  const http = new x402HTTPClient(client);

  return {
    address: signer.address,
    fetchPaid: (url, init) => paid(url, init),
    settlement: (response) => {
      try {
        return http.getPaymentSettleResponse((name) => response.headers.get(name)) as Settlement | undefined;
      } catch {
        return undefined;
      }
    },
  };
}
````

- [ ] **Step 4: Run it to see it pass**

Run: `node --test services/web/test/buyer.test.ts`
Expected: PASS, 4 tests. If `settlement` of a header-less response does not return `undefined` (the library may return an empty object), keep the try/catch and make the last test assert `!buyer.settlement(...)?.transaction` instead.

---

### Task 6: The app: read-only routes, headers and the page

**Files:**
- Create: `services/web/src/app.ts`
- Create: `services/web/public/index.html` (a placeholder now; Task 8 replaces it)
- Test: `services/web/test/app.test.ts`

**Interfaces:**
- Consumes: `detect` and `browserMaskModule` from `src/mask.ts`; `Limits` from `src/limits.ts`; `Payer` from `src/buyer.ts`; `networkName`, `readBalance`, `readQuote`, `Balance`, `Quote` from `src/wallets.ts`.
- Produces: `createWebApp(deps: Deps): Hono` with `Deps = { paywallUrl: string; ratePerMinute: number; maxExecutesPerHour: number; buyer: Payer | undefined; maskModule: string; pageFile: URL; fetcher?: typeof fetch; now?: () => number; log?: (line: Record<string, unknown>) => void }`, and `MAX_MASKED_CHARS = 48_000`. Routes: `GET /`, `GET /healthz`, `GET /client-mask.js`, `GET /api/wallets`, `POST /api/execute` (Task 7).

- [ ] **Step 1: Create the placeholder page**

**Create `services/web/public/index.html`:**

````html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PrivacyBuddy</title></head><body><h1>PrivacyBuddy</h1></body></html>
````

- [ ] **Step 2: Write the failing test (read-only routes)**

**Create `services/web/test/app.test.ts`:**

````ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Payer } from "../src/buyer.ts";
import { createWebApp, MAX_MASKED_CHARS } from "../src/app.ts";
import { browserMaskModule } from "../src/mask.ts";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAYTO = "EA7WASZQYXGGRSMGYQLRI6TR2PQCVDC42QULUT5N62UMYO4A6ADCJ6464M";
const PAGE = new URL("../public/index.html", import.meta.url);

const quoteHeader = (amount = "10000") =>
  Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", network: TESTNET, amount, asset: "10458941", payTo: PAYTO }] })).toString("base64");

/** A stand-in for the paywall's quote and for a public Algorand node. */
function fakeFetch(opts: { usdc?: number; quote?: boolean; nodeDown?: boolean } = {}) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/v1/")) {
      if (opts.quote === false) return new Response("{}", { status: 503 });
      return new Response("{}", { status: 402, headers: { "payment-required": quoteHeader() } });
    }
    if (url.includes("/v2/accounts/")) {
      if (opts.nodeDown) throw new Error("node down");
      return Response.json({ amount: 4_000_000, assets: opts.usdc === undefined ? [] : [{ "asset-id": 10458941, amount: Math.round(opts.usdc * 1e6) }] });
    }
    throw new Error("unexpected request " + url);
  };
}

function fakePayer(respond: (body: any) => Response | Promise<Response>) {
  const calls: { url: string; body: any }[] = [];
  const payer: Payer = {
    address: "BUYERADDRESS",
    fetchPaid: async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      return respond(body);
    },
    settlement: () => ({ success: true, transaction: "TXID123", network: TESTNET }),
  };
  return { payer, calls };
}

export function makeApp(over: Partial<Parameters<typeof createWebApp>[0]> = {}) {
  const logs: Record<string, unknown>[] = [];
  const app = createWebApp({
    paywallUrl: "http://paywall.test",
    ratePerMinute: 100,
    maxExecutesPerHour: 100,
    buyer: undefined,
    maskModule: browserMaskModule(),
    pageFile: PAGE,
    fetcher: fakeFetch({ usdc: 5 }),
    log: (line) => logs.push(line),
    ...over,
  });
  return { app, logs };
}

describe("page and static routes", () => {
  it("serves the page with security headers", async () => {
    const { app } = makeApp();
    const r = await app.request("/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(await r.text(), /PrivacyBuddy/);
  });

  it("answers /healthz", async () => {
    const r = await makeApp().app.request("/healthz");
    assert.deepEqual(await r.json(), { status: "ok" });
  });

  it("serves the masking module as JavaScript", async () => {
    const r = await makeApp().app.request("/client-mask.js");
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    assert.match(await r.text(), /export function maskText/);
  });

  it("answers an unknown path with a JSON 404", async () => {
    const r = await makeApp().app.request("/nope");
    assert.equal(r.status, 404);
    assert.ok((await r.json() as any).error.message);
  });
});

describe("GET /api/wallets", () => {
  it("shows the buyer with its balance, the pay-to address, the network and the chat price", async () => {
    const { payer } = fakePayer(() => new Response("{}"));
    const r = await makeApp({ buyer: payer }).app.request("/api/wallets");
    assert.deepEqual(await r.json(), {
      network: "testnet",
      asset: "10458941",
      buyer: { address: "BUYERADDRESS", usdc: 5, algo: 4, optedIn: true },
      payTo: { address: PAYTO },
      prices: { chat: 0.01 },
    });
  });

  it("shows buyer null when no key is set", async () => {
    const body = (await (await makeApp().app.request("/api/wallets")).json()) as any;
    assert.equal(body.buyer, null);
    assert.equal(body.payTo.address, PAYTO);
  });

  it("still answers when the paywall cannot quote: unknown network, no pay-to", async () => {
    const { payer } = fakePayer(() => new Response("{}"));
    const body = (await (await makeApp({ buyer: payer, fetcher: fakeFetch({ quote: false }) }).app.request("/api/wallets")).json()) as any;
    assert.deepEqual([body.network, body.payTo, body.prices.chat], ["unknown", null, null]);
  });

  it("leaves the balance null when the Algorand node is down", async () => {
    const { payer } = fakePayer(() => new Response("{}"));
    const body = (await (await makeApp({ buyer: payer, fetcher: fakeFetch({ nodeDown: true }) }).app.request("/api/wallets")).json()) as any;
    assert.deepEqual([body.buyer.address, body.buyer.usdc, body.buyer.algo], ["BUYERADDRESS", null, null]);
  });

  it("never puts anything but the public address in the answer", async () => {
    const { payer } = fakePayer(() => new Response("{}"));
    const text = await (await makeApp({ buyer: payer }).app.request("/api/wallets")).text();
    assert.ok(!/mnemonic|secret|seed/i.test(text));
  });
});

export { fakeFetch, fakePayer, MAX_MASKED_CHARS };
````

- [ ] **Step 3: Run it to see it fail**

Run: `node --test services/web/test/app.test.ts`
Expected: FAIL, cannot find `../src/app.ts`.

- [ ] **Step 4: Implement the app (routes except execute)**

**Create `services/web/src/app.ts`:**

````ts
/**
 * The PrivacyBuddy web app: the page, the browser masking module, the wallet
 * read, and the one paid action (execute). Everything it depends on is passed
 * in, so the tests run it with a fake payer and a stand-in paywall.
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Payer } from "./buyer.ts";
import { Limits } from "./limits.ts";
import { detect } from "./mask.ts";
import { networkName, readBalance, readQuote, type Balance, type Quote } from "./wallets.ts";

const CHAT = "/v1/chat/completions";
const SCAN = "/v1/privacy/scan";
/** The gateway's chat limit, in characters of message text. */
export const MAX_MASKED_CHARS = 48_000;

export type Deps = {
  paywallUrl: string;
  ratePerMinute: number;
  maxExecutesPerHour: number;
  buyer: Payer | undefined;
  /** client-mask.ts as browser JavaScript. */
  maskModule: string;
  /** The page, read on every request so an edit shows without a restart. */
  pageFile: URL;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Status, sizes and timing only. Never text, placeholders or the map. */
  log?: (line: Record<string, unknown>) => void;
};

const fail = (c: Context, status: 400 | 402 | 429 | 502 | 503, message: string) => c.json({ error: { message } }, status);

function cached<T>(ttlMs: number, now: () => number, load: () => Promise<T>): () => Promise<T> {
  let value: { at: number; v: T } | undefined;
  return async () => {
    if (value && now() - value.at < ttlMs) return value.v;
    const v = await load();
    value = { at: now(), v };
    return v;
  };
}

export function createWebApp(deps: Deps): Hono {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const limits = new Limits(deps.ratePerMinute, deps.maxExecutesPerHour, now);

  // The chat quote carries the price; if chat cannot be quoted (no capacity), the scan quote still gives the pay-to address and network.
  const quote = cached<{ quote: Quote; priced: boolean }>(30_000, now, async () => {
    try {
      return { quote: await readQuote(deps.paywallUrl, CHAT, fetcher), priced: true };
    } catch {
      return { quote: await readQuote(deps.paywallUrl, SCAN, fetcher), priced: false };
    }
  });
  const balance = cached<Balance | undefined>(15_000, now, async () => {
    if (!deps.buyer) return undefined;
    const { quote: q } = await quote();
    const network = networkName(q.network);
    return network === "unknown" ? undefined : readBalance(deps.buyer.address, network, q.asset, fetcher);
  });

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
  });

  app.get("/", async (c) => c.html(await readFile(deps.pageFile, "utf8")));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/client-mask.js", (c) => c.body(deps.maskModule, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }));

  app.get("/api/wallets", async (c) => {
    const q = await quote().catch(() => undefined);
    const b = await balance().catch(() => undefined);
    return c.json({
      network: q ? networkName(q.quote.network) : "unknown",
      asset: q?.quote.asset ?? null,
      buyer: deps.buyer ? { address: deps.buyer.address, usdc: b?.usdc ?? null, algo: b?.algo ?? null, optedIn: b?.optedIn ?? null } : null,
      payTo: q ? { address: q.quote.payTo } : null,
      prices: { chat: q?.priced ? q.quote.price : null },
    });
  });

  registerExecute(app, { deps, limits, quote, balance, now, log });

  app.notFound((c) => c.json({ error: { message: "Not found." } }, 404));
  return app;
}

type ExecuteCtx = {
  deps: Deps;
  limits: Limits;
  quote: () => Promise<{ quote: Quote; priced: boolean }>;
  balance: () => Promise<Balance | undefined>;
  now: () => number;
  log: (line: Record<string, unknown>) => void;
};

/** Filled in by Task 7. */
function registerExecute(_app: Hono, _ctx: ExecuteCtx): void {}
````

- [ ] **Step 5: Run it to see it pass**

Run: `node --test services/web/test/app.test.ts`
Expected: PASS, 9 tests (4 page/static, 5 wallets).

---

### Task 7: The execute endpoint

**Files:**
- Modify: `services/web/src/app.ts` (replace the `registerExecute` stub and add `upstreamMessage`)
- Modify: `services/web/test/app.test.ts` (append a `describe("POST /api/execute")` block)

**Interfaces:**
- Consumes: `fakeFetch`, `fakePayer`, `makeApp` from `test/app.test.ts`.
- Produces: `POST /api/execute` body `{ masked: string, maxTokens?: number }` → 200 `{ answer: string, model: string | null, dataClass: string | null, payment: { transaction: string | null, network: string | null } }`; errors `{ error: { message } }` with status 400, 402, 429, 502 or 503.

- [ ] **Step 1: Append the failing tests**

Append to `services/web/test/app.test.ts` (after the existing blocks):

````ts
const ok = (content = "Here is your answer for <C_PERSON_1>.") =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "x-chainaim-model": "free/model:free", "x-chainaim-data-class": "PII" } });

const post = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/execute", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const errorOf = async (r: Response) => ((await r.json()) as any).error.message as string;

describe("POST /api/execute", () => {
  it("pays the chat route with only the masked text and returns the answer and the receipt", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const { app } = makeApp({ buyer: payer });
    const r = await post(app, { masked: "Write to <C_PERSON_1> about the refund." });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      answer: "Here is your answer for <C_PERSON_1>.",
      model: "free/model:free",
      dataClass: "PII",
      payment: { transaction: "TXID123", network: TESTNET },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://paywall.test/v1/chat/completions");
    assert.deepEqual(calls[0].body, { model: "chainaim/auto", messages: [{ role: "user", content: "Write to <C_PERSON_1> about the refund." }], max_tokens: 512 });
  });

  it("passes a valid maxTokens on", async () => {
    const { payer, calls } = fakePayer(() => ok());
    await post(makeApp({ buyer: payer }).app, { masked: "hi", maxTokens: 100 });
    assert.equal(calls[0].body.max_tokens, 100);
  });

  it("refuses an empty message, a bad body and a bad maxTokens without paying", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const { app } = makeApp({ buyer: payer });
    assert.equal((await post(app, { masked: "   " })).status, 400);
    assert.equal((await post(app, "not json")).status, 400);
    assert.equal((await post(app, { masked: "hi", maxTokens: 0 })).status, 400);
    assert.equal((await post(app, { masked: "hi", maxTokens: 2000 })).status, 400);
    assert.equal((await post(app, { masked: "hi", maxTokens: "9" })).status, 400);
    assert.equal(calls.length, 0);
  });

  it("refuses text over the limit without paying", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const r = await post(makeApp({ buyer: payer }).app, { masked: "a".repeat(MAX_MASKED_CHARS + 1) });
    assert.equal(r.status, 400);
    assert.match(await errorOf(r), /limit is 48000/);
    assert.equal(calls.length, 0);
  });

  it("refuses text that still holds a raw value, even when posted directly, and pays nothing", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const r = await post(makeApp({ buyer: payer }).app, { masked: "Email priya.raman@example.com please" });
    assert.equal(r.status, 400);
    assert.match(await errorOf(r), /still holds values that should be masked/);
    assert.equal(calls.length, 0);
  });

  it("says 503 when no buyer key is set", async () => {
    const r = await post(makeApp().app, { masked: "hi" });
    assert.equal(r.status, 503);
    assert.match(await errorOf(r), /not set up/);
  });

  it("limits each visitor per minute and all visitors per hour", async () => {
    const { payer } = fakePayer(() => ok());
    const { app } = makeApp({ buyer: payer, ratePerMinute: 2, maxExecutesPerHour: 3 });
    const a = { "x-forwarded-for": "1.1.1.1" };
    assert.equal((await post(app, { masked: "hi" }, a)).status, 200);
    assert.equal((await post(app, { masked: "hi" }, a)).status, 200);
    const third = await post(app, { masked: "hi" }, a);
    assert.equal(third.status, 429);
    assert.match(await errorOf(third), /Wait a minute/);
    assert.equal((await post(app, { masked: "hi" }, { "x-forwarded-for": "2.2.2.2" })).status, 200);
    const capped = await post(app, { masked: "hi" }, { "x-forwarded-for": "3.3.3.3" });
    assert.equal(capped.status, 429);
    assert.match(await errorOf(capped), /hourly limit/);
  });

  it("does not pay when the buyer is known to be short of USDC", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const r = await post(makeApp({ buyer: payer, fetcher: fakeFetch({ usdc: 0 }) }).app, { masked: "hi" });
    assert.equal(r.status, 402);
    assert.match(await errorOf(r), /has 0 USDC and this answer costs 0.01/);
    assert.equal(calls.length, 0);
  });

  it("lets the paywall decide when the balance cannot be read", async () => {
    const { payer, calls } = fakePayer(() => ok());
    const r = await post(makeApp({ buyer: payer, fetcher: fakeFetch({ nodeDown: true }) }).app, { masked: "hi" });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
  });

  it("passes the gateway's own refusal message on, as a 502", async () => {
    const { payer } = fakePayer(() => new Response(JSON.stringify({ error: { message: "every model tried failed; you were not charged" } }), { status: 503 }));
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
    assert.equal(await errorOf(r), "every model tried failed; you were not charged");
  });

  it("explains a payment the paywall did not accept", async () => {
    const { payer } = fakePayer(() => new Response("{}", { status: 402 }));
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
    assert.match(await errorOf(r), /payment was not accepted.*not charged/);
  });

  it("gives a generic message when the upstream failure has no readable message", async () => {
    const { payer } = fakePayer(() => new Response("<html>boom</html>", { status: 500 }));
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
    assert.match(await errorOf(r), /HTTP 500.*not charged/);
  });

  it("says so when the payment service cannot be reached", async () => {
    const { payer } = fakePayer(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
    assert.match(await errorOf(r), /Could not reach the payment service/);
  });

  it("does not hand on an answer it cannot read", async () => {
    const { payer } = fakePayer(() => new Response("{}", { status: 200 }));
    const r = await post(makeApp({ buyer: payer }).app, { masked: "hi" });
    assert.equal(r.status, 502);
  });

  it("never logs the submitted text", async () => {
    const { payer } = fakePayer(() => ok());
    const { app, logs } = makeApp({ buyer: payer });
    await post(app, { masked: "The <C_PERSON_1> secret-marker-7781 asked" });
    assert.ok(logs.length > 0, "something is logged");
    assert.ok(!JSON.stringify(logs).includes("secret-marker-7781"));
    assert.ok(!JSON.stringify(logs).includes("C_PERSON_1"));
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test services/web/test/app.test.ts`
Expected: the new `POST /api/execute` tests FAIL (404 instead of the expected statuses); the earlier 9 still pass.

- [ ] **Step 3: Implement**

In `services/web/src/app.ts`, replace the last two lines (the comment `/** Filled in by Task 7. */` and the `function registerExecute(...) {}` stub) with:

**Replace the stub at the end of `services/web/src/app.ts` with:**

````ts
/** What to tell the user about a failed paid call. The gateway's own messages hold no user text. */
function upstreamMessage(status: number, text: string): string {
  let message = "";
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === "string") message = m;
  } catch {
    /* not JSON */
  }
  if (status === 402) return "The payment was not accepted. The buyer wallet may need TestNet USDC. You were not charged.";
  if (message) return message.slice(0, 300);
  return `The chat service failed (HTTP ${status}). You were not charged.`;
}

function registerExecute(app: Hono, ctx: ExecuteCtx): void {
  const { deps, limits, quote, balance, now, log } = ctx;

  app.post("/api/execute", async (c) => {
    const started = now();
    const done = (status: number, extra: Record<string, unknown> = {}) => log({ route: "execute", status, ms: now() - started, ...extra });

    const body = (await c.req.json().catch(() => undefined)) as { masked?: unknown; maxTokens?: unknown } | undefined;
    const masked = typeof body?.masked === "string" ? body.masked : "";
    if (masked.trim() === "") {
      done(400);
      return fail(c, 400, "Write a message and mask it first.");
    }
    if (masked.length > MAX_MASKED_CHARS) {
      done(400);
      return fail(c, 400, `That message is ${masked.length} characters after masking; the limit is ${MAX_MASKED_CHARS}.`);
    }
    const maxTokens = body?.maxTokens === undefined ? 512 : body.maxTokens;
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024) {
      done(400);
      return fail(c, 400, "maxTokens must be a whole number from 1 to 1024.");
    }
    // The same self-check as scripts/private-ask.ts: only text with nothing left to mask goes on, even if someone posts here directly.
    if (detect(masked).length > 0) {
      done(400);
      return fail(c, 400, "That text still holds values that should be masked, such as an email, a phone number or a card number. Mask it first. Nothing was sent or paid.");
    }
    if (!deps.buyer) {
      done(503);
      return fail(c, 503, "The demo buyer wallet is not set up on this server.");
    }
    const visitor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const limited = limits.take(visitor);
    if (limited) {
      done(429);
      return fail(c, 429, limited === "visitor" ? "Too many requests. Wait a minute and try again." : "The demo has reached its hourly limit. Try again later.");
    }

    // Only stop when we know the wallet is short; if the balance cannot be read, the paywall decides.
    const q = await quote().catch(() => undefined);
    const b = await balance().catch(() => undefined);
    if (q?.priced && b && b.usdc < q.quote.price) {
      done(402);
      return fail(c, 402, `The demo buyer wallet has ${b.usdc} USDC and this answer costs ${q.quote.price}. Fund it with TestNet USDC and try again. Nothing was sent.`);
    }

    let response: Response;
    try {
      response = await deps.buyer.fetchPaid(deps.paywallUrl + CHAT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens }),
      });
    } catch {
      done(502);
      return fail(c, 502, "Could not reach the payment service. You were not charged.");
    }
    const text = await response.text();
    if (!response.ok) {
      done(502, { upstream: response.status });
      return fail(c, 502, upstreamMessage(response.status, text));
    }
    let answer: unknown;
    try {
      answer = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    } catch {
      answer = undefined;
    }
    if (typeof answer !== "string") {
      done(502, { upstream: 200 });
      return fail(c, 502, "The model's answer could not be read. Check the payment receipt before trying again.");
    }
    const settled = deps.buyer.settlement(response);
    done(200, { maskedChars: masked.length });
    return c.json({
      answer,
      model: response.headers.get("x-chainaim-model"),
      dataClass: response.headers.get("x-chainaim-data-class"),
      payment: { transaction: settled?.transaction ?? null, network: settled?.network ?? null },
    });
  });
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `node --test services/web/test/app.test.ts`
Expected: PASS, 23 tests in total.

- [ ] **Step 5: Checkpoint: the whole service suite**

Run: `npm --prefix services/web test`
Expected: all test files pass (config 5, limits 5, mask 4, wallets 9, buyer 4, app 23).

---

### Task 8: Start-up

**Files:**
- Create: `services/web/src/main.ts`
- Test: `services/web/test/main.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `createBuyer`, `createWebApp`, `browserMaskModule`.
- Produces: the runnable service: `npm --prefix services/web start`.

- [ ] **Step 1: Write the failing test**

**Create `services/web/test/main.test.ts`:**

````ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { get } from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** A plain GET with no keep-alive: a pooled connection still closing when the runner exits can crash Node on Windows. */
const getText = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    get(url, { agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });

describe("main", () => {
  it("exits with a clear message when PAYWALL_URL is missing", () => {
    const r = spawnSync(process.execPath, [MAIN], { env: { ...process.env, PAYWALL_URL: "" }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PAYWALL_URL/);
  });

  it("exits with a clear message, without echoing the words, when BUYER_MNEMONIC is not a valid phrase", () => {
    const r = spawnSync(process.execPath, [MAIN], { env: { ...process.env, PAYWALL_URL: "http://127.0.0.1:1", BUYER_MNEMONIC: "totally invalid words here" }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BUYER_MNEMONIC/);
    assert.ok(!r.stderr.includes("totally invalid words here"));
  });

  it("starts without a buyer key and serves the page and /healthz", async () => {
    const port = 18741;
    const child = spawn(process.execPath, [MAIN], { env: { ...process.env, PAYWALL_URL: "http://127.0.0.1:1", PORT: String(port), BUYER_MNEMONIC: "" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("did not start")), 15000);
        child.stdout.on("data", (d) => {
          if (String(d).includes("privacybuddy")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", (code) => reject(new Error("exited " + code)));
      });
      const health = await getText(`http://127.0.0.1:${port}/healthz`);
      assert.deepEqual(JSON.parse(health.body), { status: "ok" });
      const page = await getText(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.match(page.body, /PrivacyBuddy/);
    } finally {
      // Wait for the child to be gone and close its pipes, or Node on Windows can crash while shutting down.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
});
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test services/web/test/main.test.ts`
Expected: FAIL (the child exits because `src/main.ts` does not exist).

- [ ] **Step 3: Implement**

**Create `services/web/src/main.ts`:**

````ts
/**
 * PrivacyBuddy web: entry point. Configuration comes from the environment; see
 * src/config.ts and README.md. BUYER_MNEMONIC is optional: without it the page
 * works up to the Execute step, which then says the buyer wallet is not set up.
 */
import { serve } from "@hono/node-server";
import { createWebApp } from "./app.ts";
import { createBuyer, type Payer } from "./buyer.ts";
import { loadConfig, type WebConfig } from "./config.ts";
import { browserMaskModule } from "./mask.ts";

let config: WebConfig;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`[privacybuddy] ${(e as Error).message}`);
  process.exit(1);
}

// Read the words once, then take them out of the environment so nothing started later can see them.
const mnemonic = process.env.BUYER_MNEMONIC?.trim();
delete process.env.BUYER_MNEMONIC;
let buyer: Payer | undefined;
if (mnemonic) {
  try {
    buyer = await createBuyer(mnemonic);
  } catch {
    console.error("[privacybuddy] BUYER_MNEMONIC is not a valid 25-word Algorand phrase");
    process.exit(1);
  }
}

const app = createWebApp({
  paywallUrl: config.paywallUrl,
  ratePerMinute: config.ratePerMinute,
  maxExecutesPerHour: config.maxExecutesPerHour,
  buyer,
  maskModule: browserMaskModule(),
  pageFile: new URL("../public/index.html", import.meta.url),
  log: (line) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line })),
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[privacybuddy] listening on http://${config.host}:${info.port}  paywall=${config.paywallUrl}  buyer=${buyer ? buyer.address : "not set (Execute is off)"}`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
````

- [ ] **Step 4: Run it to see it pass**

Run: `node --test services/web/test/main.test.ts`
Expected: PASS, 3 tests.

---

### Task 9: The page

**Files:**
- Replace: `services/web/public/index.html`

**Interfaces:**
- Consumes: `GET /api/wallets`, `POST /api/execute`, `GET /client-mask.js` (exports `maskText(text) => { masked, map, counts, cardsRemoved }` and `restore(text, map) => { text, unresolved }`).
- Produces: the page. No new server interface.

- [ ] **Step 1: Write the page**

**Replace `services/web/public/index.html`:**

````html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PrivacyBuddy: spend your tokens wisely</title>
<meta name="description" content="Private AI chat. Your secrets are masked on your device, and you pay per answer in USDC on Algorand.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234f46e5'/%3E%3Cpath d='M16 6l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V9z' fill='white'/%3E%3C/svg%3E">
<style>
  :root {
    --bg: #f5f6fb; --bg2: #e6eafd; --card: #ffffff; --ink: #15182b; --muted: #5b6178; --line: #e1e4f0;
    --brand: #4f46e5; --brand2: #06b6d4; --ok: #15803d; --warn: #b42318; --warnbg: #fef3f2; --code: #f1f3fb;
    --ph: #4338ca; --phbg: rgba(79, 70, 229, .13); --orig: #0e7490; --origbg: rgba(6, 182, 212, .16);
    --shadow: 0 12px 32px rgba(40, 50, 120, .12);
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg: #0b0d1a; --bg2: #141846; --card: #151931; --ink: #eef0ff; --muted: #a4abc7; --line: #262b4d;
    --brand: #8b8cff; --brand2: #22d3ee; --ok: #4ade80; --warn: #ff9a90; --warnbg: #2a1416; --code: #1b2040;
    --ph: #b4b5ff; --phbg: rgba(139, 140, 255, .18); --orig: #67e8f9; --origbg: rgba(34, 211, 238, .16);
    --shadow: 0 12px 32px rgba(0, 0, 0, .4);
  } }
  * { box-sizing: border-box; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
  body { margin: 0; min-height: 100vh; color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1100px 520px at 88% -8%, var(--bg2), transparent 62%), radial-gradient(900px 520px at -8% 6%, var(--bg2), transparent 58%), var(--bg); }
  a { color: var(--brand); }
  button { font: inherit; }
  :focus-visible { outline: 3px solid var(--brand2); outline-offset: 2px; }

  .bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px; max-width: 1080px; margin: 0 auto; padding: 18px 20px; }
  .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.15rem; letter-spacing: -.01em; color: var(--ink); text-decoration: none; }
  .brand svg { width: 34px; height: 34px; flex: none; }
  .wallets { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); box-shadow: 0 2px 8px rgba(40, 50, 120, .06); font-size: .85rem; }
  .chip .lab { color: var(--muted); font-weight: 600; }
  .chip .addr { font: .82rem ui-monospace, Consolas, monospace; }
  .chip .bal { font-weight: 700; color: var(--ok); }
  .chip .bal.low { color: var(--warn); }
  .chip button, .chip a.go { border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 999px; padding: 2px 9px; cursor: pointer; font-size: .75rem; text-decoration: none; }
  .chip button:hover, .chip a.go:hover { color: var(--brand); border-color: var(--brand); }

  main { max-width: 820px; margin: 0 auto; padding: 8px 20px 56px; }
  .hero { text-align: center; padding: 34px 0 26px; }
  h1 { margin: 0 0 12px; font-size: clamp(2.1rem, 6.4vw, 3.6rem); line-height: 1.05; letter-spacing: -.03em; }
  .grad { background: linear-gradient(90deg, var(--brand), var(--brand2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lead { margin: 0 auto 16px; max-width: 34rem; color: var(--muted); font-size: 1.1rem; }
  .trust { list-style: none; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 0; padding: 0; }
  .trust li { padding: 5px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); font-size: .85rem; color: var(--muted); }
  .trust li::before { content: "✓ "; color: var(--ok); font-weight: 800; }

  .card { background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: clamp(16px, 4vw, 28px); box-shadow: var(--shadow); }
  .steps { display: flex; gap: 8px; list-style: none; margin: 0 0 18px; padding: 0; }
  .steps li { flex: 1; text-align: center; padding: 8px 6px; border-radius: 12px; font-size: .88rem; font-weight: 600; color: var(--muted); background: var(--code); border: 1px solid transparent; transition: all .2s; }
  .steps li b { display: inline-grid; place-items: center; width: 22px; height: 22px; margin-right: 6px; border-radius: 50%; background: var(--line); color: var(--ink); font-size: .78rem; }
  .steps li.on { color: var(--ink); border-color: var(--brand); background: var(--phbg); }
  .steps li.on b { background: linear-gradient(135deg, var(--brand), var(--brand2)); color: #fff; }
  .steps li.done b { background: var(--ok); color: #fff; }
  .lab2 { display: block; margin: 0 0 6px; font-size: .8rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
  textarea { width: 100%; min-height: 150px; resize: vertical; padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--code); color: var(--ink); font: inherit; }
  textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--phbg); }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
  .btn { padding: 11px 20px; border-radius: 12px; border: 1px solid var(--brand); cursor: pointer; font-weight: 700; }
  .btn.primary { color: #fff; background: linear-gradient(135deg, var(--brand), #6d5bf7 55%, var(--brand2)); border-color: transparent; box-shadow: 0 6px 18px rgba(79, 70, 229, .35); }
  .btn.primary:hover { filter: brightness(1.06); }
  .btn.ghost { color: var(--brand); background: transparent; }
  .btn:disabled { opacity: .55; cursor: wait; box-shadow: none; }
  .hint { margin: 12px 0 0; color: var(--muted); font-size: .86rem; }

  .pane { margin-top: 18px; padding-top: 18px; border-top: 1px dashed var(--line); animation: rise .25s ease-out; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .doc { background: var(--code); border-radius: 14px; padding: 14px; white-space: pre-wrap; word-break: break-word; line-height: 1.75; max-height: 320px; overflow: auto; }
  mark.ph { background: var(--phbg); color: var(--ph); border-radius: 6px; padding: 1px 6px; font: .86em ui-monospace, Consolas, monospace; font-weight: 600; }
  mark.orig { background: var(--origbg); color: var(--orig); border-radius: 6px; padding: 1px 4px; box-shadow: inset 0 -2px 0 var(--orig); }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
  .pill { padding: 3px 11px; border: 1px solid var(--line); border-radius: 999px; font-size: .8rem; background: var(--card); color: var(--muted); }
  .pill.good { color: var(--ok); border-color: var(--ok); }
  .answer { background: var(--code); border-radius: 16px; padding: 16px 18px; }
  .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
  .md p, .md ul, .md ol, .md pre, .md blockquote { margin: 0 0 .75em; }
  .md ul, .md ol { padding-left: 1.4em; }
  .md h1, .md h2, .md h3 { font-size: 1.05rem; margin: .8em 0 .4em; letter-spacing: 0; }
  .md code { background: var(--line); padding: 1px 5px; border-radius: 5px; font: .88em ui-monospace, Consolas, monospace; }
  .md pre { background: var(--line); padding: 10px; border-radius: 10px; overflow: auto; } .md pre code { background: none; padding: 0; }
  .md blockquote { padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }
  .receipt { margin-top: 12px; padding: 10px 14px; border: 1px solid var(--ok); border-radius: 12px; font-size: .9rem; color: var(--ok); }
  .receipt code { font: .85rem ui-monospace, Consolas, monospace; }
  .error { margin-top: 14px; padding: 12px 14px; border: 1px solid var(--warn); border-radius: 12px; background: var(--warnbg); color: var(--warn); }
  .error a { color: inherit; font-weight: 700; }
  .busy { display: flex; align-items: center; gap: 10px; margin-top: 14px; color: var(--muted); }
  .spin { width: 18px; height: 18px; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--brand); animation: turn .8s linear infinite; }
  @keyframes turn { to { transform: rotate(360deg); } }
  footer { text-align: center; padding: 10px 20px 36px; color: var(--muted); font-size: .85rem; }
  @media (max-width: 560px) { .wallets { justify-content: flex-start; } .steps li { font-size: .78rem; } .steps li b { display: none; } }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header class="bar">
  <a class="brand" href="/" aria-label="PrivacyBuddy home">
    <svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M16 6l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V9z" fill="#fff"/><path d="M12.5 15.5l2.6 2.6 4.6-5" fill="none" stroke="#4f46e5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>PrivacyBuddy</span>
  </a>
  <div class="wallets" id="wallets" aria-label="Wallets" aria-live="polite"></div>
</header>

<main>
  <section class="hero">
    <h1>Spend your tokens <span class="grad">wisely</span></h1>
    <p class="lead">Private AI chat. Your secrets are masked on your device, and you pay per answer in USDC on Algorand.</p>
    <ul class="trust"><li>Masked on your device</li><li>Pay per answer with x402</li><li>No account needed</li></ul>
  </section>

  <section class="card" aria-labelledby="chatTitle">
    <ol class="steps" aria-label="Steps">
      <li id="s1" class="on"><b>1</b>Write</li>
      <li id="s2"><b>2</b>Masked</li>
      <li id="s3"><b>3</b>Execute</li>
    </ol>
    <label class="lab2" for="msg" id="chatTitle">Your private message</label>
    <textarea id="msg" rows="6" placeholder="Type a message. Put names after a label, like “Name: …”, so they can be masked."></textarea>
    <div class="row">
      <button class="btn primary" id="maskBtn" type="button">Mask my message</button>
      <button class="btn ghost" id="exampleBtn" type="button">Try an example</button>
    </div>
    <p class="hint">Masking runs on your device with pattern checks. ChainAim's server scans the masked text again before any model sees it.</p>

    <div class="pane" id="maskedPane" hidden>
      <span class="lab2">What will be sent (masked)</span>
      <div class="pills" id="maskedPills"></div>
      <div class="doc" id="maskedView"></div>
      <div class="row">
        <button class="btn primary" id="execBtn" type="button">Execute</button>
        <button class="btn ghost" id="editBtn" type="button">Edit message</button>
      </div>
    </div>

    <div id="status" role="status" aria-live="polite"></div>

    <div class="pane" id="answerPane" hidden>
      <span class="lab2">Answer</span>
      <div class="pills" id="answerPills"></div>
      <div class="answer md" id="answerView"></div>
      <div class="receipt" id="receipt" hidden></div>
      <div class="row"><button class="btn ghost" id="againBtn" type="button">Start over</button></div>
    </div>
  </section>
</main>
<footer>PrivacyBuddy by ChainAim · payments settle with x402 on Algorand</footer>

<script type="module">
import { maskText, restore } from "/client-mask.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "…");
/** Keep in step with EXAMPLE in test/mask.test.ts. */
const EXAMPLE = "Name: Priya Raman\nEmail: priya.raman@example.com\nPhone: +91 98765 43210\nPAN: AJZPR4821K\n\nPlease write a short, polite email asking my landlord to refund my security deposit of INR 50,000.";
const PLACEHOLDER = /(<C_[A-Z_]+_\d+>|\[CARD REMOVED\])/;
/** Friendly names for what client-mask.ts finds: [one, many]. */
const KIND = {
  PERSON: ["name", "names"], EMAIL_ADDRESS: ["email address", "email addresses"], PHONE_NUMBER: ["phone number", "phone numbers"],
  IN_PAN: ["PAN number", "PAN numbers"], IN_AADHAAR: ["Aadhaar number", "Aadhaar numbers"], IN_IFSC: ["bank IFSC code", "bank IFSC codes"],
  IN_BANK_ACCOUNT: ["bank account number", "bank account numbers"], MEDICAL_RECORD: ["medical record number", "medical record numbers"], CREDIT_CARD: ["card number", "card numbers"],
};

let wallets = null;
let current = null; // { masked, map } for the message on screen

/* ---------- wallets, top right ---------- */
const loraBase = () => `https://lora.algokit.io/${wallets?.network === "mainnet" ? "mainnet" : "testnet"}`;

async function copy(text, button) {
  try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
  catch { window.prompt("Copy this address", text); }
  setTimeout(() => { button.textContent = "Copy"; }, 1400);
}

function chip(label, address, extra) {
  const c = el("div", { className: "chip" }, el("span", { className: "lab", textContent: label }));
  if (!address) { c.append(el("span", { className: "addr", textContent: "not available" })); return c; }
  const copyBtn = el("button", { type: "button", textContent: "Copy", title: `Copy the ${label} address` });
  copyBtn.onclick = () => copy(address, copyBtn);
  c.append(el("span", { className: "addr", textContent: short(address), title: address }));
  if (extra) c.append(extra);
  c.append(copyBtn, el("a", { className: "go", href: `${loraBase()}/account/${address}`, target: "_blank", rel: "noopener", textContent: "↗", title: "Open on lora" }));
  return c;
}

function renderWallets() {
  const box = $("wallets");
  box.replaceChildren();
  if (!wallets) return;
  let bal;
  if (wallets.buyer && wallets.buyer.usdc !== null) bal = el("span", { className: "bal" + (wallets.buyer.usdc <= 0 ? " low" : ""), textContent: `${wallets.buyer.usdc} USDC` });
  box.append(chip("Buyer", wallets.buyer?.address, bal), chip("Pay to", wallets.payTo?.address));
  const price = wallets.prices?.chat;
  $("execBtn").textContent = price ? `Execute · $${price}` : "Execute";
}

async function loadWallets() {
  try { wallets = await (await fetch("/api/wallets")).json(); } catch { wallets = null; }
  renderWallets();
}

/* ---------- steps ---------- */
function setStep(n) {
  for (const i of [1, 2, 3]) { const li = $("s" + i); li.className = i < n ? "done" : i === n ? "on" : ""; }
}

/* ---------- a small, safe Markdown view for the answer: text nodes only ---------- */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/;
function inline(text, parent) {
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) parent.append(el("strong", { textContent: part.slice(2, -2) }));
    else if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) parent.append(el("code", { textContent: part.slice(1, -1) }));
    else if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) parent.append(el("em", { textContent: part.slice(1, -1) }));
    else parent.append(part);
  }
  return parent;
}
const LIST = /^\s*([-*+]|\d+[.)])\s+/;
function markdown(src) {
  const root = el("div");
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; root.append(el("pre", {}, el("code", { textContent: code.join("\n") }))); continue; }
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { root.append(inline(h[2], el("h" + h[1].length))); i++; continue; }
    if (LIST.test(line)) { const list = el(/^\s*\d/.test(line) ? "ol" : "ul"); while (i < lines.length && LIST.test(lines[i])) list.append(inline(lines[i++].replace(LIST, ""), el("li"))); root.append(list); continue; }
    if (/^>\s?/.test(line)) { const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, "")); root.append(inline(q.join(" "), el("blockquote"))); continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>)/.test(lines[i]) && !LIST.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    const p = el("p"); para.forEach((t, k) => { if (k) p.append(el("br")); inline(t, p); }); root.append(p);
  }
  return root;
}

/** Highlight, in the rendered answer, every original value that was put back. */
function markValues(root, values) {
  const list = [...new Set(values)].filter((v) => v.length > 2).sort((a, b) => b.length - a.length);
  if (!list.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const node of nodes) {
    const text = node.nodeValue;
    const out = [];
    let at = 0;
    for (;;) {
      let best = -1, found = "";
      for (const v of list) { const i = text.indexOf(v, at); if (i !== -1 && (best === -1 || i < best)) { best = i; found = v; } }
      if (best === -1) break;
      if (best > at) out.push(text.slice(at, best));
      out.push(el("mark", { className: "orig", textContent: found }));
      at = best + found.length;
    }
    if (!out.length) continue;
    if (at < text.length) out.push(text.slice(at));
    node.replaceWith(...out);
  }
}

/* ---------- the three steps ---------- */
const pill = (t, cls = "") => el("span", { className: "pill " + cls, textContent: t });
const clearStatus = () => $("status").replaceChildren();
function showBusy(text) { $("status").replaceChildren(el("div", { className: "busy" }, el("span", { className: "spin" }), text)); }
function showError(message, status) {
  const box = el("div", { className: "error", role: "alert" }, message);
  if (status === 402 || /USDC/.test(message)) box.append(" ", el("a", { href: "https://faucet.circle.com", target: "_blank", rel: "noopener", textContent: "Get TestNet USDC" }));
  $("status").replaceChildren(box);
}

function doMask() {
  clearStatus();
  $("answerPane").hidden = true;
  const text = $("msg").value.trim();
  if (!text) { showError("Write a message first, or press “Try an example”."); return; }
  const r = maskText(text);
  current = { masked: r.masked, map: r.map };
  const view = $("maskedView");
  view.replaceChildren();
  r.masked.split(PLACEHOLDER).forEach((part, i) => view.append(i % 2 ? el("mark", { className: "ph", textContent: part }) : part));
  const pills = $("maskedPills");
  pills.replaceChildren();
  const kinds = Object.entries(r.counts);
  if (kinds.length === 0 && r.cardsRemoved === 0) pills.append(pill("Nothing sensitive found", "good"));
  for (const [type, n] of kinds) { const [one, many] = KIND[type] ?? [type.toLowerCase().replaceAll("_", " "), type.toLowerCase().replaceAll("_", " ")]; pills.append(pill(`${n} ${n === 1 ? one : many} hidden`, "good")); }
  if (r.cardsRemoved > 0) pills.append(pill(`${r.cardsRemoved} card number removed for good`, "good"));
  pills.append(pill("nothing has left your device"));
  $("maskedPane").hidden = false;
  setStep(2);
  $("execBtn").focus({ preventScroll: true });
}

async function doExecute() {
  if (!current) return;
  $("execBtn").disabled = true;
  showBusy("Paying with USDC and asking the model…");
  try {
    const r = await fetch("/api/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ masked: current.masked }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showError(j.error?.message ?? `Something went wrong (HTTP ${r.status}).`, r.status); return; }
    clearStatus();
    showAnswer(j);
  } catch {
    showError("Could not reach PrivacyBuddy's server. Is it running?");
  } finally {
    $("execBtn").disabled = false;
    loadWallets();
  }
}

function showAnswer(j) {
  const restored = restore(j.answer, current.map);
  const view = $("answerView");
  view.replaceChildren(markdown(restored.text));
  markValues(view, Object.values(current.map));
  const pills = $("answerPills");
  pills.replaceChildren(pill("your original values are back", "good"));
  if (j.model) pills.append(pill(`model: ${j.model}`));
  if (j.dataClass) pills.append(pill(`data class: ${j.dataClass}`));
  const receipt = $("receipt");
  receipt.replaceChildren();
  const price = wallets?.prices?.chat;
  receipt.append(price ? `Paid ${price} USDC · ` : "Paid · ");
  if (j.payment?.transaction) receipt.append("receipt ", el("a", { href: `${loraBase()}/transaction/${j.payment.transaction}`, target: "_blank", rel: "noopener" }, el("code", { textContent: `${j.payment.transaction.slice(0, 8)}…${j.payment.transaction.slice(-6)}` }), " ↗"));
  else receipt.append("the receipt was not returned");
  receipt.hidden = false;
  $("answerPane").hidden = false;
  setStep(3);
  $("answerPane").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function reset(keepText) {
  current = null;
  clearStatus();
  $("maskedPane").hidden = true;
  $("answerPane").hidden = true;
  if (!keepText) $("msg").value = "";
  setStep(1);
  $("msg").focus();
}

$("maskBtn").onclick = doMask;
$("exampleBtn").onclick = () => { reset(false); $("msg").value = EXAMPLE; doMask(); };
$("execBtn").onclick = doExecute;
$("editBtn").onclick = () => reset(true);
$("againBtn").onclick = () => reset(false);
$("msg").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doMask(); });

loadWallets();
setInterval(loadWallets, 60000);
</script>
</body>
</html>
````

- [ ] **Step 2: Checkpoint: the page is still served and the suite still passes**

Run: `npm --prefix services/web test`
Expected: all pass (the page test asserts `PrivacyBuddy` and the security headers on the real page).

---

### Task 10: README, run it, and check it in the browser

**Files:**
- Create: `services/web/README.md`

- [ ] **Step 1: Write the README**

**Create `services/web/README.md`:**

````markdown
# PrivacyBuddy web

A page for private chat: type a message, see it masked on your own device, then
Execute to pay (USDC, x402) and get the answer with your original values put back.
The buyer and pay-to wallets show top right.

Masking runs in the browser with `services/paywall/scripts/client-mask.ts`. The
server gets only masked text, re-checks it, pays the paywall's chat route from a
demo buyer wallet, and returns the answer and the payment receipt. It never logs
text, placeholders or the restore map.

## Run it on your PC

Start the paywall first (the test console's `start.cmd` does, at http://127.0.0.1:8080).

PowerShell, from the repository folder. The 25 words are typed at a hidden prompt and
only live in this window:

```powershell
$env:PAYWALL_URL = "http://127.0.0.1:8080"
$s = Read-Host "Buyer 25 words (TestNet demo wallet only)" -AsSecureString
$env:BUYER_MNEMONIC = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
npm --prefix services/web start
```

Open http://127.0.0.1:8740. Without `BUYER_MNEMONIC` the page still works up to
Execute, which then says the buyer wallet is not set up.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `PAYWALL_URL` | the paywall's address (required) | none |
| `BUYER_MNEMONIC` | the demo buyer's 25 words; only in the environment | not set |
| `PORT`, `HOST` | where to listen | `8740`, `127.0.0.1` |
| `RATE_PER_MINUTE` | executes per visitor per minute | `5` |
| `MAX_EXECUTES_PER_HOUR` | executes across all visitors per hour (bounds what the demo wallet can spend) | `30` |

## Safety

The buyer key is a hot wallet on a server: use a TestNet demo wallet only. Before any
MainNet use, replace it with wallet connect. The buyer also needs TestNet USDC
(https://faucet.circle.com) before Execute can pay.

## Tests

```bash
npm --prefix services/web test
```
````

- [ ] **Step 2: Run the whole suite**

Run: `npm --prefix services/web test`
Expected: all pass.

- [ ] **Step 3: Start it (no buyer key) against the local paywall and look at it**

Run: `PAYWALL_URL=http://127.0.0.1:8080 node services/web/src/main.ts` (background), then open `http://127.0.0.1:8740` in the Browser pane.
Expected: the page loads; the top right shows **Pay to** `EA7WAS…464M`, and **Buyer** "not available" (no key); "Try an example" produces a masked view with `<C_…>` placeholders highlighted and the step indicator moves to 2; Execute says the buyer wallet is not set up.

- [ ] **Step 4: Check the paid path in the browser with a fake payer**

Start a scratch server (outside the repo) that imports `createWebApp` with a fake payer returning a canned answer, open it in the Browser pane, run the example, and click Execute.
Expected: the answer appears with the original name, email and phone highlighted and restored, the model and data-class pills show, and the receipt links to lora. Also check a failure (fake payer returns 503) shows the red message, and check a narrow (mobile) width.
````
