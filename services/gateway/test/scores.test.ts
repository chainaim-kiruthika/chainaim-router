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
