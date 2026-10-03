import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebApp } from "../src/app.ts";
import { browserMaskModule } from "../src/mask.ts";
import { checkChat, MAX_MASKED_CHARS } from "../src/relay.ts";

const PAGE = new URL("../public/index.html", import.meta.url);
const COOKIES = new URL("../public/cookies.html", import.meta.url);
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
    maskModule: browserMaskModule(),
    pageFile: PAGE,
    cookiesFile: COOKIES,
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

  it("warns to check the wallet when the paywall fails after a payment was sent", async () => {
    const { fetcher } = paywall(() => {
      throw new Error("socket hang up");
    });
    const r = await post(makeApp(fetcher).app, chat("hi"), { "payment-signature": "SIGNED" });
    assert.equal(r.status, 502);
    const message = await errorOf(r);
    assert.match(message, /The connection to the payment service failed after your payment was sent. Check your wallet's recent transactions before trying again./);
    assert.doesNotMatch(message, /not charged/);
  });

  it("keeps the receipt and warns when the answer is lost after the payment went through", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":[{"mess'));
        controller.error(new Error("connection reset"));
      },
    });
    const { fetcher } = paywall(() => new Response(body, { status: 200, headers: { "payment-response": "RECEIPT", "content-type": "application/json" } }));
    const { app, logs } = makeApp(fetcher);
    const r = await post(app, chat("hi"), { "payment-signature": "SIGNED" });
    assert.equal(r.status, 502);
    assert.equal(r.headers.get("payment-response"), "RECEIPT");
    assert.match(await errorOf(r), /after your payment went through/);
    assert.ok(logs.some((l) => l.route === "chat" && l.status === 502 && l.bodyLost === true && l.upstream === 200), JSON.stringify(logs));
  });

  it("says not charged when an unpaid answer cannot be read", async () => {
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(new Error("reset")) });
    const { fetcher } = paywall(() => new Response(body, { status: 402 }));
    const r = await post(makeApp(fetcher).app, chat("hi"));
    assert.equal(r.status, 502);
    assert.match(await errorOf(r), /Could not read the payment service's answer. You were not charged./);
  });

  it("refuses a body over 256 KB with 413 without calling the paywall", async () => {
    const { fetcher, seen } = paywall(() => new Response("{}"));
    const { app, logs } = makeApp(fetcher);
    const r = await post(app, chat("a".repeat(300 * 1024)));
    assert.equal(r.status, 413);
    assert.equal(await errorOf(r), "That request is too large.");
    assert.equal(seen.length, 0);
    assert.ok(logs.some((l) => l.route === "chat" && l.status === 413));
  });

  it("never logs the text, the payment header or the receipt", async () => {
    const { fetcher } = paywall(() => Response.json({}, { headers: { "payment-response": "RECEIPT-77" } }));
    const { app, logs } = makeApp(fetcher);
    await post(app, chat("The <C_PERSON_1> secret-marker-7781 asked"), { "payment-signature": "SIG-99" });
    const all = JSON.stringify(logs);
    assert.ok(logs.length > 0, "something is logged");
    for (const s of ["secret-marker-7781", "C_PERSON_1", "SIG-99", "RECEIPT-77"]) assert.ok(!all.includes(s), s);
    assert.equal(logs[0].route, "chat");
    assert.equal(logs[0].withPayment, true);
    assert.equal("paid" in logs[0], false);
  });
});
