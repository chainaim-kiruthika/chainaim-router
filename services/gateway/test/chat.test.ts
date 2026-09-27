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
import { CORPUS } from "../../../scripts/synthetic-corpus.ts";
import { leaked, ledgerText, post, startTestGateway, withCardsRemoved, type TestGateway, type TestGatewayOptions } from "./helpers.ts";

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
