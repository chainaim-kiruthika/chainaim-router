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
