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

  it("rejects an unknown task, a missing or non-finite health answer and an out-of-range difficulty", () => {
    assert.equal(parseJevAnswers(answers({ task: { type: "choice", choice: "poetry" } })), undefined);
    assert.equal(parseJevAnswers(answers({ health: undefined })), undefined);
    assert.equal(parseJevAnswers(answers({ health: { type: "noul", noul: Number.NaN } })), undefined);
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
