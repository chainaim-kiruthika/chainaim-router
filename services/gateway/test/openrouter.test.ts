/**
 * OpenRouter request shaping, failure categories (spec section 7) and one
 * model attempt against the stub OpenRouter.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubOpenRouter, STUB_MODELS, type StubOpenRouter } from "../../../scripts/stub-openrouter.ts";
import { attemptChat, parseCompletion } from "../src/dispatch.ts";
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
    ["no endpoints for the model, on a deny request", 404, err("No endpoints found for stub/alpha-70b:free."), "deny", { outcome: "upstream_error" }],
    ["key 401", 401, err("No auth credentials found"), "allow", { outcome: "key_rejected" }],
    ["key 403", 403, err("Key disabled"), "allow", { outcome: "key_rejected" }],
    ["moderation 403", 403, err("flagged", { reasons: ["x"], flagged_input: "..." }), "allow", { outcome: "upstream_error" }],
    ["model gated 403 (routing ran, so the key was accepted)", 403, err("stub/x:free is only available on agentic harnesses", { routing_funnel: [{ step: "Initial Endpoints" }] }), "allow", { outcome: "model_restricted" }],
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

describe("parseCompletion", () => {
  const answer = (message: unknown) => JSON.stringify({ id: "gen-1", choices: [{ index: 0, message, finish_reason: "stop" }] });
  const call = { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } };
  const cases: [string, string, boolean][] = [
    ["text content", answer({ role: "assistant", content: "Paris." }), true],
    ["a tool call and no content", answer({ role: "assistant", content: null, tool_calls: [call] }), true],
    ["no content (the token cap ran out)", answer({ role: "assistant", content: null, reasoning: "thinking" }), false],
    ["empty content", answer({ role: "assistant", content: "" }), false],
    ["blank content", answer({ role: "assistant", content: " \n\n " }), false],
    ["an empty tool-call list", answer({ role: "assistant", content: null, tool_calls: [] }), false],
    ["no message", JSON.stringify({ choices: [{ index: 0 }] }), false],
    ["no choices", JSON.stringify({ choices: [] }), false],
    ["not JSON", "<html>oops</html>", false],
  ];
  for (const [name, text, counts] of cases) {
    it(`${name}: ${counts ? "an answer" : "not an answer"}`, () => assert.equal(parseCompletion(text) !== undefined, counts));
  }
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

  it("does not cool a model down for a moderation refusal (403 with moderation metadata)", async () => {
    or.chatModes[MODEL] = "moderation403";
    const r = await attempt();
    assert.deepEqual([r.attempt.outcome, r.attempt.status], ["upstream_error", 403]);
    assert.equal(pool.isCoolingDown(MODEL), false);
  });

  it("cools a gated model down (403 after routing ran) without calling it a rejected key", async () => {
    or.chatModes[MODEL] = "restricted403";
    const r = await attempt();
    assert.deepEqual([r.attempt.outcome, r.attempt.status], ["model_restricted", 403]);
    assert.equal(pool.isCoolingDown(MODEL), true);
  });

  it("cools a model down when OpenRouter has no endpoint for it (404)", async () => {
    or.chatModes[MODEL] = "gone404";
    const r = await attempt();
    assert.deepEqual([r.attempt.outcome, r.attempt.status], ["upstream_error", 404]);
    assert.equal(pool.isCoolingDown(MODEL), true);
  });

  it("treats an answer with no content and no tool call as an upstream error and cools the model down", async () => {
    or.chatModes[MODEL] = "empty";
    const r = await attempt();
    assert.deepEqual([r.attempt.outcome, r.attempt.status, r.completion], ["upstream_error", 200, undefined]);
    assert.equal(pool.isCoolingDown(MODEL), true);
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
