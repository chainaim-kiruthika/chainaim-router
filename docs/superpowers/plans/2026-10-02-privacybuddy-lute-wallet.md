# PrivacyBuddy Lute Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visitors to PrivacyBuddy pay for each answer from their own Lute wallet in the browser; the server holds no wallet key.

**Architecture:** The page runs the x402 client (`@x402/fetch` + `@x402/avm`) in the browser with a signer that hands transactions to Lute (`lute-connect`). The paid call goes to a new server route, `POST /api/chat`, which checks the request (this page's shape, nothing left to mask) and passes the x402 exchange through to the paywall unchanged. The browser code is bundled once with esbuild into `public/wallet.js`, which is committed.

**Tech Stack:** Node 24 (TypeScript run directly, `node --test`), Hono, `@x402/fetch` / `@x402/avm` / `@x402/core` 2.27.0, `lute-connect` 2.0.1, `buffer` 6.0.3, `esbuild` 0.28.2.

**Spec:** `docs/superpowers/specs/2026-10-02-privacybuddy-lute-wallet-design.md`

## Global Constraints

- All work is in `services/web` (plus docs). The paywall, gateway and Presidio are not changed.
- Work on `main`. The demo-video version is the tag `demo-video-v1`; never move or delete it.
- Commit messages: one short line, conventional prefix (`feat(web):`, `test(web):`, `docs:`), **no** `Co-Authored-By` trailer and no mention of Claude or Anthropic. Do not push.
- The server must never log message text, placeholders, the restore map, the `payment-signature` header or the receipt.
- Only the wallet address and its network's genesis ID are kept in the browser (`localStorage`), never anything secret.
- Max masked text: 48,000 characters. `max_tokens`: whole number 1 to 1024, default 512. Model: `chainaim/auto`.
- Relay timeout: 200,000 ms (the paywall's `GATEWAY_TIMEOUT_MS` default).
- Lute genesis IDs: TestNet `testnet-v1.0`, MainNet `mainnet-v1.0`. Algod: `https://testnet-api.algonode.cloud`, `https://mainnet-api.algonode.cloud`.
- Run commands from the repository root unless a step says otherwise. Test one file with `node --test --test-force-exit services/web/test/<file>.test.ts`; all web tests with `npm --prefix services/web test`.

## Facts checked before writing this plan

- `lute-connect` 2.0.1: `new LuteConnect(siteName)`; `connect(genesisID): Promise<string[]>` rejects `Error("Operation Cancelled")` when closed; `signTxns(WalletTransaction[]): Promise<(Uint8Array | null)[]>` where `WalletTransaction = { txn: base64, signers?: string[] }` (`signers: []` means "don't sign"); a closed window rejects `SignTxnsError` with `code === 4100`. With the extension it uses window `CustomEvent`s; without it, it opens a `https://lute.app` popup via `window.open`. Neither needs a CSP change, so no `frame-src` is added. If the popup is blocked the promise never settles, so calls get a timeout.
- `lute-connect` reads `window.screenX` when imported, so it must never be imported by Node tests. Only `src/wallet-entry.ts` imports it.
- `ExactAvmScheme.createPaymentPayload` calls `signer.signTransactions(encodedTxns, clientIndexes)` with raw unsigned transaction bytes and the indexes whose sender is our address. With a facilitator fee payer the group is `[feePayerTxn, ourTxn]` and we sign index 1.
- `@x402/avm` calls `Buffer` at runtime, so the bundle injects the `buffer` package. A trial bundle built cleanly (about 508 KB).
- `wrapFetchWithPayment` wraps a signing error as `Error("Failed to create payment payload: <message>")`.
- `core.autocrlf` is `true` here, so the bundle's source hash normalises `\r\n` to `\n`.

## File map

| File | Change | Responsibility |
|---|---|---|
| `services/web/src/lute-signer.ts` | create | Lute `signTxns` to x402 `{ address, signTransactions }` (pure, Node-testable) |
| `services/web/src/balance.ts` | create (moved from `wallets.ts`) | Network constants and the account balance read (browser-safe) |
| `services/web/src/answer.ts` | create | Turn the relay's response into the page's answer or a plain error (pure) |
| `services/web/src/relay.ts` | create | `POST /api/chat`: request checks and pass-through to the paywall |
| `services/web/src/wallet-entry.ts` | create | Browser API used by the page: `savedAccount`, `connect`, `disconnect`, `balance`, `payAndAsk` |
| `services/web/src/buffer-shim.ts` | create | esbuild inject: `Buffer` for the browser |
| `services/web/scripts/build-wallet.ts` | create | `npm run build:wallet`: bundle to `public/wallet.js` with a source-hash banner |
| `services/web/public/wallet.js` | create (generated, committed) | The browser bundle |
| `services/web/src/wallets.ts` | modify | Keep `readQuote`/`networkName`; add `networkInfo`; drop `readBalance` |
| `services/web/src/app.ts` | modify | Serve `/wallet.js`, CSP, `/api/wallets` shape, mount relay; later drop the server buyer |
| `services/web/src/main.ts`, `src/config.ts` | modify | Drop `BUYER_MNEMONIC`, rate limits |
| `services/web/src/buyer.ts`, `src/limits.ts` + tests | delete | Server wallet and its limits |
| `services/web/public/index.html` | modify | Buyer chip with Connect/Disconnect; Execute pays through `/wallet.js` |
| `services/web/package.json` | modify | Dev dependencies, `build:wallet` script |
| `.gitattributes` | modify | Mark the bundle as generated |
| `services/web/README.md`, `ONBOARDING.md` | modify | Lute instead of 25 words |

---

### Task 1: Lute signer adapter

**Files:**
- Create: `services/web/src/lute-signer.ts`
- Test: `services/web/test/lute-signer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type WalletTransaction = { txn: string; signers?: string[] }`
  - `type SignTxns = (txns: WalletTransaction[]) => Promise<(Uint8Array | null)[]>`
  - `type AvmSigner = { address: string; signTransactions(txns: Uint8Array[], indexesToSign?: number[]): Promise<(Uint8Array | null)[]> }`
  - `const CANCELLED: string` = `"You cancelled the payment. Nothing was paid."`
  - `function luteSigner(address: string, signTxns: SignTxns): AvmSigner`

- [ ] **Step 1: Write the failing test**

Create `services/web/test/lute-signer.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANCELLED, luteSigner, type WalletTransaction } from "../src/lute-signer.ts";

const A = new Uint8Array([1, 2, 3, 250]);
const B = new Uint8Array([9, 8, 7]);
const SIG = new Uint8Array([42, 42]);

function fakeLute(answer: (txns: WalletTransaction[]) => (Uint8Array | null)[] | Promise<(Uint8Array | null)[]>) {
  const seen: WalletTransaction[][] = [];
  return { seen, signTxns: async (txns: WalletTransaction[]) => (seen.push(txns), answer(txns)) };
}

describe("luteSigner", () => {
  it("keeps the address", () => {
    assert.equal(luteSigner("ADDR", fakeLute(() => []).signTxns).address, "ADDR");
  });

  it("sends each transaction to Lute as base64 of the same bytes", async () => {
    const lute = fakeLute(() => [SIG]);
    await luteSigner("ADDR", lute.signTxns).signTransactions([A]);
    assert.deepEqual(new Uint8Array(Buffer.from(lute.seen[0][0].txn, "base64")), A);
  });

  it("signs only the indexes asked for and marks the rest signers: []", async () => {
    const lute = fakeLute(() => [null, SIG]);
    const out = await luteSigner("ADDR", lute.signTxns).signTransactions([A, B], [1]);
    assert.deepEqual(lute.seen[0][0].signers, []);
    assert.equal(lute.seen[0][1].signers, undefined);
    assert.deepEqual(out, [null, SIG]);
  });

  it("signs everything when no indexes are given", async () => {
    const lute = fakeLute(() => [SIG, SIG]);
    const out = await luteSigner("ADDR", lute.signTxns).signTransactions([A, B]);
    assert.deepEqual(lute.seen[0].map((t) => t.signers), [undefined, undefined]);
    assert.deepEqual(out, [SIG, SIG]);
  });

  it("drops anything Lute returns for a transaction it was not asked to sign", async () => {
    const lute = fakeLute(() => [SIG, SIG]);
    assert.deepEqual(await luteSigner("ADDR", lute.signTxns).signTransactions([A, B], [1]), [null, SIG]);
  });

  it("turns a closed Lute window (code 4100) into the cancelled message", async () => {
    const lute = fakeLute(() => Promise.reject(Object.assign(new Error("User Rejected Request"), { code: 4100 })));
    await assert.rejects(luteSigner("ADDR", lute.signTxns).signTransactions([A]), { message: CANCELLED });
  });

  it("passes any other Lute error on", async () => {
    const lute = fakeLute(() => Promise.reject(Object.assign(new Error("boom"), { code: 4300 })));
    await assert.rejects(luteSigner("ADDR", lute.signTxns).signTransactions([A]), /boom/);
  });

  it("fails clearly when Lute leaves our own transaction unsigned", async () => {
    const lute = fakeLute(() => [null]);
    await assert.rejects(luteSigner("ADDR", lute.signTxns).signTransactions([A]), /Lute did not sign the payment/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit services/web/test/lute-signer.test.ts`
Expected: FAIL, cannot find module `../src/lute-signer.ts`.

- [ ] **Step 3: Write the implementation**

Create `services/web/src/lute-signer.ts`:

```ts
/**
 * Turns Lute's signTxns into the signer the x402 AVM client expects
 * ({ address, signTransactions }). Lute itself is passed in, so this file has
 * no browser dependency: the tests run it with a fake, and wallet-entry.ts
 * passes the real LuteConnect.
 */
export type WalletTransaction = { txn: string; signers?: string[] };
export type SignTxns = (txns: WalletTransaction[]) => Promise<(Uint8Array | null)[]>;
export type AvmSigner = {
  address: string;
  signTransactions(txns: Uint8Array[], indexesToSign?: number[]): Promise<(Uint8Array | null)[]>;
};

export const CANCELLED = "You cancelled the payment. Nothing was paid.";

/** Lute's code for a window the user closed or a request they rejected. */
const USER_REJECTED = 4100;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function luteSigner(address: string, signTxns: SignTxns): AvmSigner {
  return {
    address,
    async signTransactions(txns, indexesToSign) {
      const mine = new Set(indexesToSign ?? txns.map((_, i) => i));
      let signed: (Uint8Array | null)[];
      try {
        signed = await signTxns(txns.map((t, i) => (mine.has(i) ? { txn: toBase64(t) } : { txn: toBase64(t), signers: [] })));
      } catch (e) {
        if ((e as { code?: unknown }).code === USER_REJECTED) throw new Error(CANCELLED);
        throw e;
      }
      return txns.map((_, i) => {
        if (!mine.has(i)) return null;
        const s = signed[i];
        if (!s) throw new Error("Lute did not sign the payment. Nothing was paid.");
        return s;
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit services/web/test/lute-signer.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add services/web/src/lute-signer.ts services/web/test/lute-signer.test.ts
git commit -m "feat(web): Lute signer adapter for x402"
```

---

### Task 2: Browser-safe balance read and network constants

Moves `readBalance` out of `wallets.ts` (which uses Node's `Buffer` for the quote) into a file the browser bundle can import, and adds the per-network constants the page needs.

**Files:**
- Create: `services/web/src/balance.ts`
- Create: `services/web/test/balance.test.ts`
- Modify: `services/web/src/wallets.ts` (remove `NODES`, `Balance`, `readBalance`; add `networkInfo`)
- Modify: `services/web/test/wallets.test.ts` (drop the `readBalance` block; add `networkInfo`)
- Modify: `services/web/src/app.ts:12` (import path)

**Interfaces:**
- Consumes: nothing.
- Produces (in `src/balance.ts`):
  - `type KnownNetwork = "testnet" | "mainnet"`
  - `const NETWORKS: Record<KnownNetwork, { genesisId: string; algodUrl: string }>`
  - `type Balance = { algo: number; usdc: number; optedIn: boolean }`
  - `function readBalance(address: string, network: KnownNetwork, asset: string, fetcher?: typeof fetch): Promise<Balance>`
- Produces (in `src/wallets.ts`): `function networkInfo(name: NetworkName): { genesisId: string; algodUrl: string } | null`

- [ ] **Step 1: Write the failing tests**

Create `services/web/test/balance.test.ts` (the `readBalance` cases are moved here from `wallets.test.ts`, unchanged except the import):

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NETWORKS, readBalance } from "../src/balance.ts";

describe("NETWORKS", () => {
  it("names Lute's genesis IDs and the public algod nodes", () => {
    assert.deepEqual(NETWORKS, {
      testnet: { genesisId: "testnet-v1.0", algodUrl: "https://testnet-api.algonode.cloud" },
      mainnet: { genesisId: "mainnet-v1.0", algodUrl: "https://mainnet-api.algonode.cloud" },
    });
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
```

In `services/web/test/wallets.test.ts`:
- change the import line to `import { networkInfo, networkName, readQuote } from "../src/wallets.ts";`
- delete the whole `describe("readBalance", ...)` block
- add at the end:

```ts
describe("networkInfo", () => {
  it("gives the genesis ID and algod node for a known network, and null otherwise", () => {
    assert.deepEqual(networkInfo("testnet"), { genesisId: "testnet-v1.0", algodUrl: "https://testnet-api.algonode.cloud" });
    assert.equal(networkInfo("unknown"), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-force-exit services/web/test/balance.test.ts services/web/test/wallets.test.ts`
Expected: FAIL, cannot find module `../src/balance.ts` and `networkInfo` is not exported.

- [ ] **Step 3: Write the implementation**

Create `services/web/src/balance.ts`:

```ts
/**
 * What a wallet holds, read from a public Algorand node, and the per-network
 * constants Lute and the x402 client need. No Node-only APIs: the browser
 * bundle (wallet-entry.ts) imports this file too.
 */
export type KnownNetwork = "testnet" | "mainnet";
export type Balance = { algo: number; usdc: number; optedIn: boolean };

export const NETWORKS: Record<KnownNetwork, { genesisId: string; algodUrl: string }> = {
  testnet: { genesisId: "testnet-v1.0", algodUrl: "https://testnet-api.algonode.cloud" },
  mainnet: { genesisId: "mainnet-v1.0", algodUrl: "https://mainnet-api.algonode.cloud" },
};

export async function readBalance(address: string, network: KnownNetwork, asset: string, fetcher: typeof fetch = fetch): Promise<Balance> {
  const r = await fetcher(`${NETWORKS[network].algodUrl}/v2/accounts/${address}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`the Algorand node answered HTTP ${r.status}`);
  const j = (await r.json()) as { amount?: number; assets?: { "asset-id": number; amount: number }[] };
  const held = (j.assets ?? []).find((a) => String(a["asset-id"]) === asset);
  return { algo: (j.amount ?? 0) / 1e6, usdc: held ? held.amount / 1e6 : 0, optedIn: held !== undefined };
}
```

In `services/web/src/wallets.ts`:
- Replace the header comment's last sentence so it reads: `... taken from its own 402 quote. The wallet balance read lives in balance.ts, which the browser also uses.`
- Delete the `Balance` type, the `NODES` constant and the `readBalance` function.
- Add below the imports/types:

```ts
import { NETWORKS } from "./balance.ts";

/** Lute's genesis ID and the public algod node for a known network. */
export function networkInfo(name: NetworkName): { genesisId: string; algodUrl: string } | null {
  return name === "unknown" ? null : NETWORKS[name];
}
```

In `services/web/src/app.ts`, change line 12 to:

```ts
import { networkName, readQuote, type Quote } from "./wallets.ts";
import { readBalance, type Balance } from "./balance.ts";
```

- [ ] **Step 4: Run all web tests**

Run: `npm --prefix services/web test`
Expected: PASS, everything (the existing app tests still use `readBalance` through `app.ts`).

- [ ] **Step 5: Commit**

```bash
git add services/web/src/balance.ts services/web/src/wallets.ts services/web/src/app.ts services/web/test/balance.test.ts services/web/test/wallets.test.ts
git commit -m "refactor(web): browser-safe balance read and network constants"
```

---

### Task 3: The `/api/chat` relay, `/wallet.js` and the wallet info

Adds the new pass-through route next to the old `/api/execute` (which goes in Task 6), serves the bundle file, widens the CSP for algonode, and adds `genesisId` and `algodUrl` to `/api/wallets`.

**Files:**
- Create: `services/web/src/relay.ts`
- Create: `services/web/test/relay.test.ts`
- Modify: `services/web/src/app.ts`
- Modify: `services/web/src/main.ts:33-41` (pass `walletFile`)
- Modify: `services/web/test/app.test.ts` (`makeApp` gains `walletFile`; wallets and CSP assertions)

**Interfaces:**
- Consumes: `detect` from `src/mask.ts`; `networkInfo` from `src/wallets.ts`.
- Produces:
  - `src/relay.ts`: `const MAX_MASKED_CHARS = 48_000`; `type ChatBody`; `function checkChat(body: unknown): ChatBody | string`; `function registerRelay(app: Hono, ctx: { paywallUrl: string; fetcher: typeof fetch; now: () => number; log: (line: Record<string, unknown>) => void }): void`
  - `Deps.walletFile: URL` on `createWebApp`
  - `GET /api/wallets` → `{ network, genesisId, algodUrl, asset, buyer, payTo, prices }` (`buyer` is removed in Task 6)
  - `GET /wallet.js` → the bundle, or JSON 404 when it is not built

- [ ] **Step 1: Write the failing relay tests**

Create `services/web/test/relay.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebApp } from "../src/app.ts";
import { browserMaskModule } from "../src/mask.ts";
import { checkChat, MAX_MASKED_CHARS } from "../src/relay.ts";

const PAGE = new URL("../public/index.html", import.meta.url);
const WALLET = new URL("../public/wallet.js", import.meta.url);

type Seen = { url: string; headers: Headers; body: any };

/** A stand-in paywall chat route that records what reached it. */
function paywall(respond: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    seen.push(req);
    return respond(req);
  };
  return { seen, fetcher: fetcher as typeof fetch };
}

function makeApp(fetcher: typeof fetch) {
  const logs: Record<string, unknown>[] = [];
  const app = createWebApp({
    paywallUrl: "http://paywall.test",
    ratePerMinute: 100,
    maxExecutesPerHour: 100,
    buyer: undefined,
    maskModule: browserMaskModule(),
    pageFile: PAGE,
    walletFile: WALLET,
    fetcher,
    log: (line) => logs.push(line),
  });
  return { app, logs };
}

const chat = (content: string, extra: Record<string, unknown> = {}) => ({ model: "chainaim/auto", messages: [{ role: "user", content }], max_tokens: 512, ...extra });
const post = (app: ReturnType<typeof makeApp>["app"], body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const errorOf = async (r: Response) => ((await r.json()) as any).error.message as string;

describe("checkChat", () => {
  it("accepts this page's request and fills the default max_tokens", () => {
    assert.deepEqual(checkChat({ model: "chainaim/auto", messages: [{ role: "user", content: "hi <C_PERSON_1>" }] }), chat("hi <C_PERSON_1>"));
  });

  it("refuses anything else with a plain reason", () => {
    assert.match(checkChat("nope") as string, /JSON object/);
    assert.match(checkChat(chat("hi", { stream: true })) as string, /Unexpected field: stream/);
    assert.match(checkChat(chat("hi", { model: "gpt" })) as string, /chainaim\/auto/);
    assert.match(checkChat({ model: "chainaim/auto", messages: [{ role: "system", content: "x" }] }) as string, /one user message/);
    assert.match(checkChat({ model: "chainaim/auto", messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }) as string, /one user message/);
    assert.match(checkChat({ model: "chainaim/auto", messages: [{ role: "user", content: "a", name: "x" }] }) as string, /one user message/);
    assert.match(checkChat(chat("   ")) as string, /mask it first/);
    assert.match(checkChat(chat("a".repeat(MAX_MASKED_CHARS + 1))) as string, /limit is 48000/);
    assert.match(checkChat(chat("hi", { max_tokens: 0 })) as string, /max_tokens/);
    assert.match(checkChat(chat("hi", { max_tokens: 2000 })) as string, /max_tokens/);
    assert.match(checkChat(chat("hi", { max_tokens: "9" })) as string, /max_tokens/);
    assert.match(checkChat(chat("Email priya.raman@example.com please")) as string, /still holds values that should be masked/);
  });
});

describe("POST /api/chat", () => {
  it("passes the paywall's 402 back with its quote header and body", async () => {
    const { fetcher, seen } = paywall(() => new Response(JSON.stringify({ x402Version: 2 }), { status: 402, headers: { "payment-required": "QUOTE", "content-type": "application/json" } }));
    const r = await post(makeApp(fetcher).app, chat("Write to <C_PERSON_1>."));
    assert.equal(r.status, 402);
    assert.equal(r.headers.get("payment-required"), "QUOTE");
    assert.deepEqual(await r.json(), { x402Version: 2 });
    assert.equal(seen[0].url, "http://paywall.test/v1/chat/completions");
    assert.deepEqual(seen[0].body, chat("Write to <C_PERSON_1>."));
  });

  it("forwards the payment-signature header and no other request header", async () => {
    const { fetcher, seen } = paywall(() => new Response("{}", { status: 200 }));
    await post(makeApp(fetcher).app, chat("hi"), { "payment-signature": "SIGNED", authorization: "Bearer x", cookie: "a=b" });
    assert.equal(seen[0].headers.get("payment-signature"), "SIGNED");
    assert.equal(seen[0].headers.get("authorization"), null);
    assert.equal(seen[0].headers.get("cookie"), null);
  });

  it("passes a paid answer back with the receipt and model headers", async () => {
    const answer = { choices: [{ message: { content: "Hello <C_PERSON_1>" } }] };
    const { fetcher } = paywall(() => Response.json(answer, { headers: { "payment-response": "RECEIPT", "x-chainaim-model": "free/m:free", "x-chainaim-data-class": "PII", "set-cookie": "no=1" } }));
    const r = await post(makeApp(fetcher).app, chat("hi"), { "payment-signature": "SIGNED" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), answer);
    assert.equal(r.headers.get("payment-response"), "RECEIPT");
    assert.equal(r.headers.get("x-chainaim-model"), "free/m:free");
    assert.equal(r.headers.get("x-chainaim-data-class"), "PII");
    assert.equal(r.headers.get("set-cookie"), null);
  });

  it("refuses a bad request without calling the paywall", async () => {
    const { fetcher, seen } = paywall(() => new Response("{}"));
    const { app } = makeApp(fetcher);
    assert.equal((await post(app, "not json")).status, 400);
    assert.equal((await post(app, chat("Email priya.raman@example.com please"))).status, 400);
    assert.equal((await post(app, chat("hi", { tools: [] }))).status, 400);
    assert.equal(seen.length, 0);
  });

  it("refuses an oversized payment header without calling the paywall", async () => {
    const { fetcher, seen } = paywall(() => new Response("{}"));
    const r = await post(makeApp(fetcher).app, chat("hi"), { "payment-signature": "x".repeat(65_537) });
    assert.equal(r.status, 400);
    assert.equal(seen.length, 0);
  });

  it("says 502 and not charged when the paywall cannot be reached", async () => {
    const { fetcher } = paywall(() => {
      throw new Error("ECONNREFUSED");
    });
    const r = await post(makeApp(fetcher).app, chat("hi"));
    assert.equal(r.status, 502);
    assert.match(await errorOf(r), /Could not reach the payment service. You were not charged./);
  });

  it("never logs the text, the payment header or the receipt", async () => {
    const { fetcher } = paywall(() => Response.json({}, { headers: { "payment-response": "RECEIPT-77" } }));
    const { app, logs } = makeApp(fetcher);
    await post(app, chat("The <C_PERSON_1> secret-marker-7781 asked"), { "payment-signature": "SIG-99" });
    const all = JSON.stringify(logs);
    assert.ok(logs.length > 0, "something is logged");
    for (const s of ["secret-marker-7781", "C_PERSON_1", "SIG-99", "RECEIPT-77"]) assert.ok(!all.includes(s), s);
    assert.equal(logs[0].route, "chat");
    assert.equal(logs[0].paid, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-force-exit services/web/test/relay.test.ts`
Expected: FAIL, cannot find module `../src/relay.ts`.

- [ ] **Step 3: Write `src/relay.ts`**

```ts
/**
 * POST /api/chat: the browser's paid chat call, relayed to the paywall. The
 * browser runs the x402 client and the visitor's Lute wallet signs; this route
 * only checks that the request is this page's request with nothing left to
 * mask, then passes the x402 exchange through unchanged. It holds no key, and
 * it logs neither the text nor the payment.
 */
import type { Context, Hono } from "hono";
import { detect } from "./mask.ts";

const CHAT = "/v1/chat/completions";
/** The gateway's chat limit, in characters of message text. */
export const MAX_MASKED_CHARS = 48_000;
/** The same as the paywall's own gateway timeout. */
const RELAY_TIMEOUT_MS = 200_000;
/** A signed payment group is a few KB; anything far larger is not ours. */
const MAX_SIGNATURE_CHARS = 65_536;
/** Response headers the page needs; nothing else from the paywall is passed on. */
const PASS_BACK = ["payment-required", "payment-response", "x-chainaim-model", "x-chainaim-data-class"];

export type ChatBody = { model: "chainaim/auto"; messages: [{ role: "user"; content: string }]; max_tokens: number };

type RelayCtx = {
  paywallUrl: string;
  fetcher: typeof fetch;
  now: () => number;
  /** Status, sizes and timing only. Never text, placeholders, the map or the payment. */
  log: (line: Record<string, unknown>) => void;
};

const fail = (c: Context, status: 400 | 502, message: string) => c.json({ error: { message } }, status);

/** The validated request, rebuilt from known fields only, or the reason it was refused. */
export function checkChat(body: unknown): ChatBody | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "The request must be a JSON object.";
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !["model", "messages", "max_tokens"].includes(k));
  if (extra !== undefined) return `Unexpected field: ${extra.slice(0, 40)}.`;
  if (b.model !== "chainaim/auto") return 'model must be "chainaim/auto".';
  const m = b.messages;
  const first = Array.isArray(m) && m.length === 1 ? (m[0] as Record<string, unknown> | null) : null;
  if (!first || typeof first !== "object" || first.role !== "user" || typeof first.content !== "string" || Object.keys(first).length !== 2) {
    return "Send exactly one user message.";
  }
  const content = first.content;
  if (content.trim() === "") return "Write a message and mask it first.";
  if (content.length > MAX_MASKED_CHARS) return `That message is ${content.length} characters after masking; the limit is ${MAX_MASKED_CHARS}.`;
  const maxTokens = b.max_tokens === undefined ? 512 : b.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024) return "max_tokens must be a whole number from 1 to 1024.";
  // The same self-check as scripts/private-ask.ts: only text with nothing left to mask goes on, even if someone posts here directly.
  if (detect(content).length > 0) {
    return "That text still holds values that should be masked, such as an email, a phone number or a card number. Mask it first. Nothing was sent or paid.";
  }
  return { model: "chainaim/auto", messages: [{ role: "user", content }], max_tokens: maxTokens };
}

export function registerRelay(app: Hono, ctx: RelayCtx): void {
  const { paywallUrl, fetcher, now, log } = ctx;

  app.post("/api/chat", async (c) => {
    const started = now();
    const signature = c.req.header("payment-signature");
    const done = (status: number, extra: Record<string, unknown> = {}) => log({ route: "chat", status, paid: signature !== undefined, ms: now() - started, ...extra });

    if (signature !== undefined && signature.length > MAX_SIGNATURE_CHARS) {
      done(400);
      return fail(c, 400, "The payment header is too large.");
    }
    const checked = checkChat(await c.req.json().catch(() => undefined));
    if (typeof checked === "string") {
      done(400);
      return fail(c, 400, checked);
    }

    let upstream: Response;
    try {
      upstream = await fetcher(paywallUrl + CHAT, {
        method: "POST",
        headers: { "content-type": "application/json", ...(signature !== undefined ? { "payment-signature": signature } : {}) },
        body: JSON.stringify(checked),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch {
      done(502);
      return fail(c, 502, "Could not reach the payment service. You were not charged.");
    }

    const headers: Record<string, string> = { "content-type": upstream.headers.get("content-type") ?? "application/json" };
    for (const name of PASS_BACK) {
      const value = upstream.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const body = await upstream.arrayBuffer();
    done(upstream.status, { upstream: upstream.status, maskedChars: checked.messages[0].content.length });
    return new Response(body, { status: upstream.status, headers });
  });
}
```

- [ ] **Step 4: Wire it into `src/app.ts`**

Make these edits in `services/web/src/app.ts`:

1. Imports: replace the line `import { detect } from "./mask.ts";` with
   ```ts
   import { detect } from "./mask.ts";
   import { MAX_MASKED_CHARS, registerRelay } from "./relay.ts";
   ```
   and change the wallets import to `import { networkInfo, networkName, readQuote, type Quote } from "./wallets.ts";`
2. Replace
   ```ts
   /** The gateway's chat limit, in characters of message text. */
   export const MAX_MASKED_CHARS = 48_000;
   ```
   with
   ```ts
   export { MAX_MASKED_CHARS };
   ```
3. In `Deps`, after `pageFile: URL;` add:
   ```ts
     /** public/wallet.js: the Lute and x402 browser bundle (npm run build:wallet). */
     walletFile: URL;
   ```
4. In the CSP header string, replace `connect-src 'self'` with
   `connect-src 'self' https://testnet-api.algonode.cloud https://mainnet-api.algonode.cloud`.
5. After the `/client-mask.js` route add:
   ```ts
   app.get("/wallet.js", async (c) => {
     const js = await readFile(deps.walletFile, "utf8").catch(() => undefined);
     if (js === undefined) return c.json({ error: { message: "public/wallet.js is not built. Run npm run build:wallet." } }, 404);
     return c.body(js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
   });
   ```
6. In `/api/wallets`, replace the `return c.json({ ... network: ...` object's first line so the object starts:
   ```ts
   const network = q ? networkName(q.quote.network) : "unknown";
   const info = networkInfo(network);
   return c.json({
     network,
     genesisId: info?.genesisId ?? null,
     algodUrl: info?.algodUrl ?? null,
     asset: q?.quote.asset ?? null,
   ```
   (keep the existing `buyer`, `payTo` and `prices` lines after it).
7. After `registerExecute(app, { ... });` add:
   ```ts
   registerRelay(app, { paywallUrl: deps.paywallUrl, fetcher, now, log });
   ```

In `services/web/src/main.ts`, in the `createWebApp({ ... })` call, after the `pageFile:` line add:

```ts
  walletFile: new URL("../public/wallet.js", import.meta.url),
```

In `services/web/test/app.test.ts`:
- after `const PAGE = ...` add `const WALLET = new URL("../public/wallet.js", import.meta.url);`
- in `makeApp`, after `pageFile: PAGE,` add `walletFile: WALLET,`
- in the first `/api/wallets` test, the expected object becomes:
  ```ts
  {
    network: "testnet",
    genesisId: "testnet-v1.0",
    algodUrl: "https://testnet-api.algonode.cloud",
    asset: "10458941",
    buyer: { address: "BUYERADDRESS", usdc: 5, algo: 4, optedIn: true },
    payTo: { address: PAYTO },
    prices: { chat: 0.01 },
  }
  ```
- in "serves the page with security headers" add:
  ```ts
  assert.match(r.headers.get("content-security-policy") ?? "", /connect-src 'self' https:\/\/testnet-api\.algonode\.cloud/);
  ```
- add to `describe("page and static routes", ...)`:
  ```ts
  it("answers a JSON 404 for /wallet.js when the bundle is not built", async () => {
    const r = await makeApp({ walletFile: new URL("../public/no-such-file.js", import.meta.url) }).app.request("/wallet.js");
    assert.equal(r.status, 404);
    assert.match(((await r.json()) as any).error.message, /build:wallet/);
  });
  ```

- [ ] **Step 5: Run all web tests**

Run: `npm --prefix services/web test`
Expected: PASS (relay, app, and the rest).

- [ ] **Step 6: Commit**

```bash
git add services/web/src/relay.ts services/web/src/app.ts services/web/src/main.ts services/web/test/relay.test.ts services/web/test/app.test.ts
git commit -m "feat(web): /api/chat relay for browser-paid x402 chat"
```

---

### Task 4: Browser bundle (`/wallet.js`)

**Files:**
- Create: `services/web/src/answer.ts`
- Create: `services/web/test/answer.test.ts`
- Create: `services/web/src/wallet-entry.ts`
- Create: `services/web/src/buffer-shim.ts`
- Create: `services/web/scripts/build-wallet.ts`
- Create: `services/web/test/wallet-bundle.test.ts`
- Create (generated): `services/web/public/wallet.js`
- Modify: `services/web/package.json`, `services/web/package-lock.json`
- Modify: `.gitattributes`

**Interfaces:**
- Consumes: `luteSigner`, `CANCELLED` (Task 1); `readBalance`, `KnownNetwork`, `Balance` (Task 2); `/api/chat` (Task 3).
- Produces (exports of `/wallet.js`, used by the page in Task 5):
  - `type PayNetwork = { name: KnownNetwork; genesisId: string; algodUrl: string; asset: string }`
  - `savedAccount(): { address: string; genesisId: string } | null`
  - `connect(genesisId: string): Promise<string>` (the address)
  - `disconnect(): void`
  - `balance(address: string, net: PayNetwork): Promise<Balance>`
  - `payAndAsk(address: string, net: PayNetwork, masked: string, maxTokens?: number): Promise<Answer | Failure>`
- Produces (`src/answer.ts`): `type Answer = { answer: string; model: string | null; dataClass: string | null; payment: { transaction: string | null; network: string | null } }`, `type Failure = { error: string; status: number }`, `function readAnswer(status: number, text: string, header: (name: string) => string | null, settled: { transaction?: string; network?: string } | undefined): Answer | Failure`
- Produces (`scripts/build-wallet.ts`): `BUNDLE: URL`, `sourceHash(): string`, `buildWallet(): Promise<void>`

- [ ] **Step 1: Install the dev dependencies**

Run (from the repository root):

```bash
npm --prefix services/web install --save-dev --save-exact esbuild@0.28.2 lute-connect@2.0.1 buffer@6.0.3
```

Then add to `scripts` in `services/web/package.json`:

```json
"build:wallet": "node scripts/build-wallet.ts"
```

- [ ] **Step 2: Write the failing tests for `readAnswer`**

Create `services/web/test/answer.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAnswer } from "../src/answer.ts";

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
const answerText = JSON.stringify({ choices: [{ message: { content: "Hi <C_PERSON_1>" } }] });

describe("readAnswer", () => {
  it("reads the answer, model, data class and receipt", () => {
    assert.deepEqual(readAnswer(200, answerText, headers({ "x-chainaim-model": "m:free", "x-chainaim-data-class": "PII" }), { transaction: "TX1", network: "algorand:x" }), {
      answer: "Hi <C_PERSON_1>",
      model: "m:free",
      dataClass: "PII",
      payment: { transaction: "TX1", network: "algorand:x" },
    });
  });

  it("still answers when there is no receipt", () => {
    const a = readAnswer(200, answerText, headers({}), undefined);
    assert.deepEqual("payment" in a && a.payment, { transaction: null, network: null });
  });

  it("explains a payment that was not accepted", () => {
    assert.deepEqual(readAnswer(402, "{}", headers({}), undefined), {
      error: "The payment was not accepted. Check that your wallet holds TestNet USDC and has opted in to it. You were not charged.",
      status: 402,
    });
  });

  it("passes the service's own message on, cut to 300 characters", () => {
    const r = readAnswer(503, JSON.stringify({ error: { message: "every model tried failed; you were not charged" } }), headers({}), undefined);
    assert.deepEqual(r, { error: "every model tried failed; you were not charged", status: 503 });
    const long = readAnswer(400, JSON.stringify({ error: { message: "x".repeat(400) } }), headers({}), undefined);
    assert.equal("error" in long && long.error.length, 300);
  });

  it("gives a generic message when the failure has no readable message", () => {
    assert.deepEqual(readAnswer(500, "<html>", headers({}), undefined), { error: "The chat service failed (HTTP 500). You were not charged.", status: 500 });
  });

  it("does not hand on an answer it cannot read", () => {
    assert.deepEqual(readAnswer(200, "{}", headers({}), { transaction: "TX1" }), {
      error: "The model's answer could not be read. Check the payment receipt before trying again.",
      status: 502,
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test --test-force-exit services/web/test/answer.test.ts`
Expected: FAIL, cannot find module `../src/answer.ts`.

- [ ] **Step 4: Write `src/answer.ts`**

```ts
/**
 * Turns the /api/chat response into what the page shows: the answer with its
 * model, data class and receipt, or one plain sentence saying what went wrong.
 * Pure, so Node tests it and the browser bundle uses the same code.
 */
export type Answer = { answer: string; model: string | null; dataClass: string | null; payment: { transaction: string | null; network: string | null } };
export type Failure = { error: string; status: number };

function explain(status: number, text: string): string {
  if (status === 402) return "The payment was not accepted. Check that your wallet holds TestNet USDC and has opted in to it. You were not charged.";
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === "string" && m) return m.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return `The chat service failed (HTTP ${status}). You were not charged.`;
}

export function readAnswer(
  status: number,
  text: string,
  header: (name: string) => string | null,
  settled: { transaction?: string; network?: string } | undefined,
): Answer | Failure {
  if (status < 200 || status >= 300) return { error: explain(status, text), status };
  let answer: unknown;
  try {
    answer = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  } catch {
    answer = undefined;
  }
  if (typeof answer !== "string") return { error: "The model's answer could not be read. Check the payment receipt before trying again.", status: 502 };
  return {
    answer,
    model: header("x-chainaim-model"),
    dataClass: header("x-chainaim-data-class"),
    payment: { transaction: settled?.transaction ?? null, network: settled?.network ?? null },
  };
}
```

Run: `node --test --test-force-exit services/web/test/answer.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the browser entry and the Buffer shim**

Create `services/web/src/buffer-shim.ts`:

```ts
/** esbuild injects this into the browser bundle: @x402/avm calls Node's Buffer at runtime. */
export { Buffer } from "buffer";
```

Create `services/web/src/wallet-entry.ts`:

```ts
/**
 * The browser side of paying with Lute, bundled into public/wallet.js by
 * scripts/build-wallet.ts (npm run build:wallet). The page imports these
 * functions from /wallet.js. Only the address and its network's genesis ID are
 * kept in localStorage; Lute keeps the keys.
 */
import LuteConnect from "lute-connect";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { readAnswer, type Answer, type Failure } from "./answer.ts";
import { readBalance, type Balance, type KnownNetwork } from "./balance.ts";
import { CANCELLED, luteSigner } from "./lute-signer.ts";

export type PayNetwork = { name: KnownNetwork; genesisId: string; algodUrl: string; asset: string };

const KEY = "privacybuddy.lute";
/** A blocked Lute popup never answers, so every Lute call has a time limit. */
const CONNECT_MS = 120_000;
const SIGN_MS = 180_000;
const NO_LUTE = "Lute could not open. Install the Lute extension, or allow pop-ups for this page.";

let lute: LuteConnect | undefined;
const luteApp = () => (lute ??= new LuteConnect("PrivacyBuddy"));

function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function savedAccount(): { address: string; genesisId: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { address?: unknown; genesisId?: unknown } | null;
    return v && typeof v.address === "string" && typeof v.genesisId === "string" ? { address: v.address, genesisId: v.genesisId } : null;
  } catch {
    return null;
  }
}

export async function connect(genesisId: string): Promise<string> {
  let addresses: string[];
  try {
    addresses = await within(luteApp().connect(genesisId), CONNECT_MS, NO_LUTE);
  } catch (e) {
    const m = String((e as Error)?.message ?? "");
    throw new Error(/cancel/i.test(m) ? "You closed Lute before connecting. Nothing was shared." : NO_LUTE);
  }
  const address = addresses[0];
  if (!address) throw new Error("Lute did not share an account.");
  try {
    localStorage.setItem(KEY, JSON.stringify({ address, genesisId }));
  } catch {
    /* private window: the page asks again next time */
  }
  return address;
}

export function disconnect(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

export const balance = (address: string, net: PayNetwork): Promise<Balance> => readBalance(address, net.name, net.asset);

export async function payAndAsk(address: string, net: PayNetwork, masked: string, maxTokens = 512): Promise<Answer | Failure> {
  const signer = luteSigner(address, (txns) => within(luteApp().signTxns(txns), SIGN_MS, NO_LUTE));
  const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer, { algodUrl: net.algodUrl }));
  const paid = wrapFetchWithPayment(fetch, client);
  let r: Response;
  try {
    r = await paid("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens }),
    });
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (m.includes(CANCELLED)) throw new Error(CANCELLED);
    if (m.includes(NO_LUTE)) throw new Error(NO_LUTE);
    throw new Error(`The payment could not be made (${m.slice(0, 200)}). Nothing was paid.`);
  }
  const text = await r.text();
  let settled: { transaction?: string; network?: string } | undefined;
  try {
    settled = new x402HTTPClient(client).getPaymentSettleResponse((name) => r.headers.get(name)) as typeof settled;
  } catch {
    settled = undefined;
  }
  return readAnswer(r.status, text, (name) => r.headers.get(name), settled);
}
```

- [ ] **Step 6: Write the failing bundle-freshness test**

Create `services/web/test/wallet-bundle.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUNDLE, sourceHash } from "../scripts/build-wallet.ts";

describe("public/wallet.js", () => {
  it("was built from the current source (run npm run build:wallet if this fails)", () => {
    const head = readFileSync(BUNDLE, "utf8").slice(0, 200);
    assert.match(head, new RegExp(`source sha256 ${sourceHash()}`));
  });

  it("exports what the page imports", () => {
    const js = readFileSync(BUNDLE, "utf8");
    for (const name of ["savedAccount", "connect", "disconnect", "balance", "payAndAsk"]) assert.match(js, new RegExp(`\\b${name}\\b`), name);
  });
});
```

Run: `node --test --test-force-exit services/web/test/wallet-bundle.test.ts`
Expected: FAIL, cannot find module `../scripts/build-wallet.ts`.

- [ ] **Step 7: Write the build script**

Create `services/web/scripts/build-wallet.ts`:

```ts
/**
 * Builds public/wallet.js, the browser bundle of src/wallet-entry.ts (Lute and
 * the x402 client). The bundle is committed so the server needs no build step;
 * its first line carries a hash of the sources, and test/wallet-bundle.test.ts
 * fails when the bundle is older than them. Run: npm run build:wallet
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
export const BUNDLE = new URL("public/wallet.js", root);
const SOURCES = ["src/wallet-entry.ts", "src/lute-signer.ts", "src/balance.ts", "src/answer.ts", "src/buffer-shim.ts", "package-lock.json"];

/** Line endings are normalised so a Windows checkout (autocrlf) hashes the same as Linux. */
export function sourceHash(): string {
  const h = createHash("sha256");
  for (const file of SOURCES) h.update(file + "\n" + readFileSync(new URL(file, root), "utf8").replace(/\r\n/g, "\n"));
  return h.digest("hex");
}

export async function buildWallet(): Promise<void> {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [fileURLToPath(new URL("src/wallet-entry.ts", root))],
    outfile: fileURLToPath(BUNDLE),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    inject: [fileURLToPath(new URL("src/buffer-shim.ts", root))],
    define: { global: "globalThis" },
    legalComments: "eof",
    banner: { js: `/* PrivacyBuddy wallet bundle, built by npm run build:wallet; source sha256 ${sourceHash()} */` },
    logLevel: "info",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWallet();
```

- [ ] **Step 8: Build the bundle and run the tests**

Run:

```bash
npm --prefix services/web run build:wallet
```

Expected: esbuild reports `public/wallet.js` at roughly 500 KB, no errors.

Add to `.gitattributes`:

```
# generated browser bundle (npm --prefix services/web run build:wallet)
services/web/public/wallet.js -diff linguist-generated
```

Run: `npm --prefix services/web test`
Expected: PASS, including `wallet-bundle.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add .gitattributes services/web/package.json services/web/package-lock.json services/web/src/answer.ts services/web/src/wallet-entry.ts services/web/src/buffer-shim.ts services/web/scripts/build-wallet.ts services/web/public/wallet.js services/web/test/answer.test.ts services/web/test/wallet-bundle.test.ts
git commit -m "feat(web): Lute and x402 browser bundle"
```

---

### Task 5: The page pays with Lute

**Files:**
- Modify: `services/web/public/index.html` (the `<script type="module">` block, lines 150-358, and one CSS line)

**Interfaces:**
- Consumes: `/wallet.js` exports (Task 4); `/api/wallets` → `{ network, genesisId, algodUrl, asset, payTo, prices }` (Task 3); `showAnswer(j)` already reads `j.answer`, `j.model`, `j.dataClass`, `j.payment.transaction`, which matches `Answer`.
- Produces: nothing used by later tasks.

- [ ] **Step 1: Imports and state**

Replace line 151 (`import { maskText, restore } from "/client-mask.js";`) with:

```js
import { maskText, restore } from "/client-mask.js";
import { savedAccount, connect, disconnect, balance, payAndAsk } from "/wallet.js";
```

Replace the line `let wallets = null;` with:

```js
let wallets = null; // from /api/wallets: network, genesisId, algodUrl, asset, payTo, prices
let buyer = null;   // { address, usdc, algo, optedIn } once Lute is connected
const net = () => (wallets?.genesisId ? { name: wallets.network, genesisId: wallets.genesisId, algodUrl: wallets.algodUrl, asset: wallets.asset } : null);
```

- [ ] **Step 2: Buyer chip, loading and connecting**

Replace the whole `renderWallets` and `loadWallets` functions (lines 189-203) with:

```js
function buyerChip() {
  if (!buyer) {
    const b = el("button", { type: "button", className: "connect", textContent: "Connect Lute", title: "Pay from your own Lute wallet" });
    b.onclick = () => doConnect().catch((e) => showError(e.message));
    return el("div", { className: "chip" }, el("span", { className: "lab", textContent: "Buyer" }), b);
  }
  let bal;
  if (buyer.usdc !== null) bal = el("span", { className: "bal" + (buyer.usdc <= 0 ? " low" : ""), textContent: `${buyer.usdc} USDC` });
  const c = chip("Buyer", buyer.address, bal);
  const off = el("button", { type: "button", textContent: "Disconnect", title: "Forget this Lute account on this page" });
  off.onclick = () => { disconnect(); buyer = null; renderWallets(); };
  c.append(off);
  return c;
}

function renderWallets() {
  const box = $("wallets");
  box.replaceChildren();
  if (!wallets) return;
  box.append(buyerChip(), chip("Pay to", wallets.payTo?.address));
  const price = wallets.prices?.chat;
  $("execBtn").textContent = price ? `Execute · $${price}` : "Execute";
}

async function refreshBuyer() {
  const n = net();
  const saved = savedAccount();
  if (!n || !saved) { buyer = null; return; }
  if (saved.genesisId !== n.genesisId) {
    disconnect();
    buyer = null;
    showError(`Your Lute account was connected for ${saved.genesisId}, and this page now pays on ${n.genesisId}. Connect again.`);
    return;
  }
  const b = { address: saved.address, usdc: null, algo: null, optedIn: null };
  try { Object.assign(b, await balance(saved.address, n)); } catch { /* the node is down: the paywall decides */ }
  buyer = b;
}

async function loadWallets() {
  try { wallets = await (await fetch("/api/wallets")).json(); } catch { wallets = null; }
  await refreshBuyer();
  renderWallets();
}

async function doConnect() {
  const n = net();
  if (!n) throw new Error("The payment service is not answering, so the network is not known yet. Try again in a moment.");
  clearStatus();
  await connect(n.genesisId);
  await refreshBuyer();
  renderWallets();
}
```

- [ ] **Step 3: Errors link to Lute**

In `showError`, after the line that appends the faucet link, add:

```js
  if (/Lute could not open/.test(message)) box.append(" ", el("a", { href: "https://lute.app", target: "_blank", rel: "noopener", textContent: "Get Lute" }));
```

- [ ] **Step 4: Execute pays through Lute**

Replace the whole `doExecute` function (lines 300-316) with:

```js
async function doExecute() {
  if (!current) return;
  $("execBtn").disabled = true;
  try {
    if (!buyer) { showBusy("Connect your Lute wallet…"); await doConnect(); }
    const price = wallets?.prices?.chat;
    if (buyer.optedIn === false) { showError(`This wallet has not opted in to USDC (asset ${wallets.asset}) yet. Opt in from Lute first. Nothing was sent.`, 402); return; }
    if (price && buyer.usdc !== null && buyer.usdc < price) { showError(`Your wallet has ${buyer.usdc} USDC and this answer costs ${price}. Fund it with TestNet USDC and try again. Nothing was sent.`, 402); return; }
    showBusy("Approve the payment in Lute…");
    const a = await payAndAsk(buyer.address, net(), current.masked);
    if (a.error) { showError(a.error, a.status); return; }
    clearStatus();
    showAnswer(a);
  } catch (e) {
    showError(e?.message || "Something went wrong.");
  } finally {
    $("execBtn").disabled = false;
    loadWallets();
  }
}
```

- [ ] **Step 5: One CSS line**

In the `<style>` block, after the `.wallets { ... }` rule (line 33), add:

```css
  .chip .connect { font-weight: 600; }
```

- [ ] **Step 6: Run the web tests**

Run: `npm --prefix services/web test`
Expected: PASS. (The page test only checks it is served; the page itself is checked by hand in Task 8.)

- [ ] **Step 7: Check the page loads in a browser**

With the test console stack running (`test-console\start.cmd`), in PowerShell:

```powershell
$env:PAYWALL_URL = "http://127.0.0.1:8080"; npm --prefix services/web start
```

Open http://127.0.0.1:8740. Expected: no errors in the browser console; the top right shows **Buyer: Connect Lute** and the Pay to chip; Mask works as before.

- [ ] **Step 8: Commit**

```bash
git add services/web/public/index.html
git commit -m "feat(web): connect Lute and pay from the page"
```

---

### Task 6: Remove the server-side wallet

**Files:**
- Delete: `services/web/src/buyer.ts`, `services/web/src/limits.ts`, `services/web/test/buyer.test.ts`, `services/web/test/limits.test.ts`
- Modify: `services/web/src/app.ts` (full replacement below)
- Modify: `services/web/src/config.ts`, `services/web/src/main.ts`
- Modify: `services/web/test/app.test.ts`, `services/web/test/relay.test.ts`, `services/web/test/config.test.ts`, `services/web/test/main.test.ts`
- Modify: `services/web/package.json` (runtime dependencies)

**Interfaces:**
- Consumes: everything above.
- Produces: final `Deps = { paywallUrl, maskModule, pageFile, walletFile, fetcher?, now?, log? }`; final `/api/wallets` → `{ network, genesisId, algodUrl, asset, payTo, prices }`; `WebConfig = { port, host, paywallUrl }`.

- [ ] **Step 1: Update the tests first**

`services/web/test/app.test.ts`: replace the whole file with:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebApp } from "../src/app.ts";
import { browserMaskModule } from "../src/mask.ts";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAYTO = "EA7WASZQYXGGRSMGYQLRI6TR2PQCVDC42QULUT5N62UMYO4A6ADCJ6464M";
const PAGE = new URL("../public/index.html", import.meta.url);
const WALLET = new URL("../public/wallet.js", import.meta.url);

const quoteHeader = (amount = "10000") =>
  Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", network: TESTNET, amount, asset: "10458941", payTo: PAYTO }] })).toString("base64");

/** A stand-in for the paywall's quote. */
function fakeFetch(opts: { quote?: boolean } = {}) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/v1/")) {
      if (opts.quote === false) return new Response("{}", { status: 503 });
      return new Response("{}", { status: 402, headers: { "payment-required": quoteHeader() } });
    }
    throw new Error("unexpected request " + url);
  };
}

function makeApp(over: Partial<Parameters<typeof createWebApp>[0]> = {}) {
  return createWebApp({
    paywallUrl: "http://paywall.test",
    maskModule: browserMaskModule(),
    pageFile: PAGE,
    walletFile: WALLET,
    fetcher: fakeFetch(),
    ...over,
  });
}

describe("page and static routes", () => {
  it("serves the page with security headers", async () => {
    const r = await makeApp().request("/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self' https:\/\/testnet-api\.algonode\.cloud https:\/\/mainnet-api\.algonode\.cloud;/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(await r.text(), /PrivacyBuddy/);
  });

  it("answers /healthz", async () => {
    assert.deepEqual(await (await makeApp().request("/healthz")).json(), { status: "ok" });
  });

  it("serves the masking module as JavaScript", async () => {
    const r = await makeApp().request("/client-mask.js");
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    assert.match(await r.text(), /export function maskText/);
  });

  it("serves the wallet bundle as JavaScript", async () => {
    const r = await makeApp().request("/wallet.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
  });

  it("answers a JSON 404 for /wallet.js when the bundle is not built", async () => {
    const r = await makeApp({ walletFile: new URL("../public/no-such-file.js", import.meta.url) }).request("/wallet.js");
    assert.equal(r.status, 404);
    assert.match(((await r.json()) as any).error.message, /build:wallet/);
  });

  it("answers an unknown path with a JSON 404, and the old execute route is gone", async () => {
    assert.equal((await makeApp().request("/nope")).status, 404);
    assert.equal((await makeApp().request("/api/execute", { method: "POST" })).status, 404);
  });
});

describe("GET /api/wallets", () => {
  it("shows the network, Lute's genesis ID, the algod node, the pay-to address and the chat price", async () => {
    assert.deepEqual(await (await makeApp().request("/api/wallets")).json(), {
      network: "testnet",
      genesisId: "testnet-v1.0",
      algodUrl: "https://testnet-api.algonode.cloud",
      asset: "10458941",
      payTo: { address: PAYTO },
      prices: { chat: 0.01 },
    });
  });

  it("still answers when the paywall cannot quote", async () => {
    const body = (await (await makeApp({ fetcher: fakeFetch({ quote: false }) }).request("/api/wallets")).json()) as any;
    assert.deepEqual([body.network, body.genesisId, body.algodUrl, body.payTo, body.prices.chat], ["unknown", null, null, null, null]);
  });
});
```

`services/web/test/relay.test.ts`: in `makeApp`, delete the three lines `ratePerMinute: 100,`, `maxExecutesPerHour: 100,` and `buyer: undefined,`.

`services/web/test/config.test.ts`: replace the last three `it` blocks with:

```ts
  it("applies the defaults and trims a trailing slash", () => {
    assert.deepEqual(loadConfig({ PAYWALL_URL: "http://127.0.0.1:8080/" }), { port: 8740, host: "127.0.0.1", paywallUrl: "http://127.0.0.1:8080" });
  });

  it("reads overrides", () => {
    const c = loadConfig({ PAYWALL_URL: "https://paywall.example", PORT: "9000", HOST: "0.0.0.0" });
    assert.deepEqual([c.port, c.host], [9000, "0.0.0.0"]);
  });

  it("rejects a port out of range", () => {
    assert.throws(() => loadConfig({ PAYWALL_URL: "http://x.test", PORT: "abc" }), /PORT/);
    assert.throws(() => loadConfig({ PAYWALL_URL: "http://x.test", PORT: "70000" }), /PORT/);
  });
```

`services/web/test/main.test.ts`:
- delete the whole `it("exits with a clear message, without echoing the words, when BUYER_MNEMONIC is not a valid phrase", ...)` block;
- rename `"starts without a buyer key and serves the page and /healthz"` to `"starts and serves the page, /wallet.js and /healthz"`, remove `BUYER_MNEMONIC: ""` from its `env`, and after the page assertions add:
  ```ts
      const wallet = await getText(`http://127.0.0.1:${port}/wallet.js`);
      assert.equal(wallet.status, 200);
  ```

Delete the old files:

```bash
git rm services/web/src/buyer.ts services/web/src/limits.ts services/web/test/buyer.test.ts services/web/test/limits.test.ts
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `npm --prefix services/web test`
Expected: FAIL. `app.ts` still imports `./buyer.ts` and `./limits.ts`, and `/api/wallets` still returns `buyer`.

- [ ] **Step 3: Replace `src/app.ts`**

```ts
/**
 * The PrivacyBuddy web app: the page, the browser masking module, the wallet
 * bundle, what the paywall asks for, and the paid chat relay. The server holds
 * no wallet key: the visitor's Lute wallet signs each payment in the browser.
 * Everything it depends on is passed in, so the tests run it with a stand-in paywall.
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { MAX_MASKED_CHARS, registerRelay } from "./relay.ts";
import { networkInfo, networkName, readQuote, type Quote } from "./wallets.ts";

export { MAX_MASKED_CHARS };

const CHAT = "/v1/chat/completions";
const SCAN = "/v1/privacy/scan";
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' https://testnet-api.algonode.cloud https://mainnet-api.algonode.cloud; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export type Deps = {
  paywallUrl: string;
  /** client-mask.ts as browser JavaScript. */
  maskModule: string;
  /** The page, read on every request so an edit shows without a restart. */
  pageFile: URL;
  /** public/wallet.js: the Lute and x402 browser bundle (npm run build:wallet). */
  walletFile: URL;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Status, sizes and timing only. Never text, placeholders, the map or the payment. */
  log?: (line: Record<string, unknown>) => void;
};

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

  // The chat quote carries the price; if chat cannot be quoted (no capacity), the scan quote still gives the pay-to address and network.
  const quote = cached<{ quote: Quote; priced: boolean }>(30_000, now, async () => {
    try {
      return { quote: await readQuote(deps.paywallUrl, CHAT, fetcher), priced: true };
    } catch {
      return { quote: await readQuote(deps.paywallUrl, SCAN, fetcher), priced: false };
    }
  });

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("content-security-policy", CSP);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
  });

  app.get("/", async (c) => c.html(await readFile(deps.pageFile, "utf8")));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/client-mask.js", (c) => c.body(deps.maskModule, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }));
  app.get("/wallet.js", async (c) => {
    const js = await readFile(deps.walletFile, "utf8").catch(() => undefined);
    if (js === undefined) return c.json({ error: { message: "public/wallet.js is not built. Run npm run build:wallet." } }, 404);
    return c.body(js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
  });

  app.get("/api/wallets", async (c) => {
    const q = await quote().catch(() => undefined);
    const network = q ? networkName(q.quote.network) : "unknown";
    const info = networkInfo(network);
    return c.json({
      network,
      genesisId: info?.genesisId ?? null,
      algodUrl: info?.algodUrl ?? null,
      asset: q?.quote.asset ?? null,
      payTo: q ? { address: q.quote.payTo } : null,
      prices: { chat: q?.priced ? q.quote.price : null },
    });
  });

  registerRelay(app, { paywallUrl: deps.paywallUrl, fetcher, now, log });

  app.notFound((c) => c.json({ error: { message: "Not found." } }, 404));
  return app;
}
```

- [ ] **Step 4: Replace `src/config.ts`**

```ts
/**
 * Configuration from the environment. The server holds no wallet key: visitors
 * pay from their own Lute wallet in the browser.
 */
export type WebConfig = {
  port: number;
  host: string;
  paywallUrl: string;
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
  };
}
```

- [ ] **Step 5: Replace `src/main.ts`**

```ts
/**
 * PrivacyBuddy web: entry point. Configuration comes from the environment; see
 * src/config.ts and README.md. The server holds no wallet key: visitors pay
 * from their own Lute wallet in the browser (public/wallet.js).
 */
import { serve } from "@hono/node-server";
import { createWebApp } from "./app.ts";
import { loadConfig, type WebConfig } from "./config.ts";
import { browserMaskModule } from "./mask.ts";

let config: WebConfig;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`[privacybuddy] ${(e as Error).message}`);
  process.exit(1);
}

const app = createWebApp({
  paywallUrl: config.paywallUrl,
  maskModule: browserMaskModule(),
  pageFile: new URL("../public/index.html", import.meta.url),
  walletFile: new URL("../public/wallet.js", import.meta.url),
  log: (line) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line })),
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[privacybuddy] listening on http://${config.host}:${info.port}  paywall=${config.paywallUrl}  buyers pay with Lute`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- [ ] **Step 6: Runtime dependencies**

The server now needs only Hono at runtime; the x402 and algokit packages are used only by the bundle build. Move them in `services/web/package.json` so it reads:

```json
  "dependencies": {
    "@hono/node-server": "2.1.1",
    "hono": "4.13.9"
  },
  "devDependencies": {
    "@algorandfoundation/algokit-utils": "10.0.0-alpha.42",
    "@x402/avm": "2.27.0",
    "@x402/core": "2.27.0",
    "@x402/fetch": "2.27.0",
    "buffer": "6.0.3",
    "esbuild": "0.28.2",
    "lute-connect": "2.0.1"
  }
```

Then run `npm --prefix services/web install` to update the lock file, and rebuild the bundle because the lock file is part of its hash:

```bash
npm --prefix services/web run build:wallet
```

- [ ] **Step 7: Run all web tests**

Run: `npm --prefix services/web test`
Expected: PASS, no file references `buyer.ts`, `limits.ts` or `BUYER_MNEMONIC`. Check with:

```bash
git grep -n "BUYER_MNEMONIC\|RATE_PER_MINUTE\|MAX_EXECUTES_PER_HOUR\|api/execute" -- services/web
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add -A services/web
git commit -m "feat(web): drop the server-side buyer wallet"
```

---

### Task 7: Docs

**Files:**
- Modify: `services/web/README.md`
- Modify: `ONBOARDING.md` (level 5 and the table at the top)

- [ ] **Step 1: Replace `services/web/README.md`**

````markdown
# PrivacyBuddy web

A page for private chat: type a message, see it masked on your own device, then
Execute to pay (USDC, x402) from your own Lute wallet and get the answer with
your original values put back. The buyer (your Lute account) and the pay-to
wallet show top right.

Masking runs in the browser with `services/paywall/scripts/client-mask.ts`.
Paying runs in the browser too: `public/wallet.js` holds the x402 client and
`lute-connect`, and Lute signs each payment after you approve it. The server
holds no wallet key. It relays the paid call to the paywall (`POST /api/chat`)
after checking the text has nothing left to mask, and never logs text,
placeholders, the restore map or the payment.

## Run it on your PC

1. Start the paywall first (the test console's `start.cmd` does, at
   http://127.0.0.1:8080).
2. Install the Lute extension in Chrome from https://lute.app, and make or
   import a TestNet account in it. Without the extension, Lute opens as a
   pop-up from lute.app instead.
3. Give that account TestNet ALGO (https://bank.testnet.algorand.network),
   opt it in to USDC (asset 10458941), and get TestNet USDC
   (https://faucet.circle.com, choose Algorand Testnet).
4. Start the page (PowerShell, from the repository folder):

   ```powershell
   $env:PAYWALL_URL = "http://127.0.0.1:8080"
   npm --prefix services/web start
   ```

Open http://127.0.0.1:8740, click **Connect Lute**, then Mask and Execute.
Lute asks you to approve each payment.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `PAYWALL_URL` | the paywall's address (required) | none |
| `PORT`, `HOST` | where to listen | `8740`, `127.0.0.1` |

## The browser bundle

`public/wallet.js` is built from `src/wallet-entry.ts` and committed. After
changing `src/wallet-entry.ts`, `src/lute-signer.ts`, `src/balance.ts`,
`src/answer.ts`, `src/buffer-shim.ts` or the dependencies, rebuild it:

```bash
npm --prefix services/web run build:wallet
```

A test fails if the bundle is older than its sources.

## Tests

```bash
npm --prefix services/web test
```

The version of this page shown in the demo video (server-held demo wallet) is
the git tag `demo-video-v1`.
````

- [ ] **Step 2: Update `ONBOARDING.md`**

In the table at the top, change the level 5 row to:

```markdown
| 5 | The PrivacyBuddy web page, paying per answer from your Lute wallet on TestNet | The Lute wallet extension |
```

Replace the whole `## 5. PrivacyBuddy, the web page (optional)` section, up to `## Everyday use`, with:

````markdown
## 5. PrivacyBuddy, the web page (optional)

The page masks a message in the browser, then pays the paywall's chat route
from **your own Lute wallet**, and shows the answer with the real values put
back. Nobody types the 25 words: Lute keeps them and asks you to approve each
payment. It needs the level 3 stack running, and real models from level 4 for
real answers.

1. Install the Lute extension in Chrome from https://lute.app and make or
   import a TestNet account in it. This is the buyer; don't use the paywall's
   pay-to account.
2. Fund it with TestNet ALGO at https://bank.testnet.algorand.network.
3. Opt it in to TestNet USDC (asset 10458941) and get TestNet USDC at
   https://faucet.circle.com (choose Algorand Testnet).

Then, in PowerShell from the project folder:

```powershell
$env:PAYWALL_URL = "http://127.0.0.1:8080"
npm --prefix services/web start
```

Open http://127.0.0.1:8740 and click **Connect Lute** (top right). Mask a
message, press Execute, and approve the 0.01 USDC payment in Lute. You can look
the transaction up at `https://lora.algokit.io/testnet/transaction/<TX ID>`.

The page as it was in the demo video (a demo wallet held by the server) is the
git tag `demo-video-v1`.
````

- [ ] **Step 3: Commit**

```bash
git add services/web/README.md ONBOARDING.md
git commit -m "docs: PrivacyBuddy pays with Lute; onboarding guide"
```

---

### Task 8: Full check and the TestNet payment

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run every suite**

```bash
npm test
```

```bash
npm run test:paywall
```

```bash
npm --prefix services/web test
```

Expected: all pass. The gateway and paywall suites are unchanged by this work and must still pass.

- [ ] **Step 2: Real TestNet payment (the owner does this)**

The agent prepares this; the owner approves in Lute, because the agent can't drive the extension.

1. Start the stack with `test-console\start.cmd` and real models with `test-console\use-real-models.cmd`.
2. Start the page as in Task 7, open http://127.0.0.1:8740 in Chrome with Lute installed.
3. Click **Connect Lute**, choose the TestNet buyer account. Expected: the Buyer chip shows its address and USDC balance.
4. Press **Try an example**, then **Execute**, and approve in Lute. Expected: the answer appears with the original values highlighted, and "Paid 0.01 USDC · receipt …".
5. Open the receipt link on lora. Expected: 0.01 USDC from the buyer to the pay-to address.
6. Run `docker logs ca-paywall` and check for one `payment_settled` line with the same transaction ID.
7. Reload the page. Expected: still connected, no Lute prompt. Click **Disconnect**. Expected: **Connect Lute** is back.
8. Press Execute and close the Lute window. Expected: "You cancelled the payment. Nothing was paid."

- [ ] **Step 3: Report**

Tell the owner the result of each check, and that nothing has been pushed (`main` and the `demo-video-v1` tag are local until they say to push).
