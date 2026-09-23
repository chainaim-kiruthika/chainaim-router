/**
 * Smoke-test a running chainaim-gateway.
 *
 *   node scripts/smoke.ts [--gateway http://127.0.0.1:8700] [--api-key-env NAME]
 *
 * Asserts routing, dispatch, pinning, error codes, streaming and that the
 * explain endpoint does not echo the prompt. Works against any backend whose
 * catalog declares local/qwen2.5-0.5b and local/qwen2.5-1.5b (llama.cpp,
 * Ollama, or scripts/stub-models.ts). Exit code 0 = all checks passed.
 */
import { parseArgs } from "node:util";

const { values: f } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8700" },
    "api-key-env": { type: "string" },
    "max-tokens": { type: "string", default: "32" },
    timeout: { type: "string", default: "180000" },
  },
});

const G = f.gateway!.replace(/\/+$/, "");
const key = f["api-key-env"] ? process.env[f["api-key-env"]] : undefined;
const maxTokens = Number(f["max-tokens"]);
const timeoutMs = Number(f.timeout);
const SMALL = "local/qwen2.5-0.5b";
const LARGE = "local/qwen2.5-1.5b";

let passed = 0;
let failed = 0;
function chk(label: string, expected: unknown, actual: unknown): void {
  if (String(expected) === String(actual)) {
    console.log(`  ok   ${label} (${actual})`);
    passed++;
  } else {
    console.log(`  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) });
const post = (path: string, body: unknown) =>
  fetch(`${G}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
const chat = (body: Record<string, unknown>) => post("/v1/chat/completions", body);
const msg = (content: string) => [{ role: "user", content }];

async function status(body: Record<string, unknown>): Promise<number> {
  return (await chat(body)).status;
}
async function explain(model: string, content: string, extra: Record<string, unknown> = {}) {
  const r = await post("/v1/route/explain", { model, messages: msg(content), ...extra });
  return (await r.json()) as { decision: { tier?: string; chain: string[]; taskType?: string; agentRisk?: string } };
}

console.log(`smoke: ${G}\n`);

console.log("== liveness");
chk("healthz", "ok", ((await (await fetch(`${G}/healthz`)).json()) as { status: string }).status);

console.log("== routing decisions (no inference)");
const cases: [string, string, string, string][] = [
  ["auto/simple", "chainaim/auto", "What is the capital of France?", `SIMPLE ${SMALL}`],
  ["premium/simple", "chainaim/premium", "What is the capital of France?", `SIMPLE ${LARGE}`],
  ["auto/reasoning", "chainaim/auto", "Prove that the sum of two odd integers is even, step by step.", `REASONING ${LARGE}`],
  ["eco/code", "chainaim/eco", "Refactor this python function to be async and add tests: def fetch(url): return requests.get(url).text", `MEDIUM ${SMALL}`],
];
for (const [label, model, prompt, want] of cases) {
  const d = (await explain(model, prompt)).decision;
  chk(label, want, `${d.tier} ${d.chain[0]}`);
}

console.log("== privacy");
const secret = "CANARY-8f21c";
const raw = await (await post("/v1/route/explain", { model: "chainaim/auto", messages: msg(secret) })).text();
chk("prompt not echoed by explain", true, !raw.includes(secret));

// Which model answers is asserted above, on prompts both strategies agree on.
// Here we only assert that dispatch works: portfolio legitimately routes some
// prompts differently (e.g. it classifies arithmetic as reasoning_math and
// upgrades the tier), so pinning an exact model here would fail on --strategy
// portfolio for a correct decision.
console.log("== dispatch");
const r1 = await chat({ model: "chainaim/auto", max_tokens: maxTokens, messages: msg("What is 12 times 8?") });
const j1 = (await r1.json()) as { choices?: { message?: { content?: string } }[] };
chk("served a catalog model", true, [SMALL, LARGE].includes(r1.headers.get("x-chainaim-model") ?? ""));
chk("attempts", "1", r1.headers.get("x-chainaim-attempts"));
chk("decision id present", true, (r1.headers.get("x-chainaim-decision-id") ?? "").length > 0);
chk("non-empty answer", true, (j1.choices?.[0]?.message?.content ?? "").trim().length > 0);

console.log("== pinned model bypasses routing");
const r2 = await chat({ model: LARGE, max_tokens: 16, messages: msg("hi") });
await r2.arrayBuffer();
chk("pinned served", LARGE, r2.headers.get("x-chainaim-model"));
chk("no tier header", null, r2.headers.get("x-chainaim-tier"));

console.log("== errors");
chk("unknown model 404", 404, await status({ model: "openai/gpt-4o", messages: msg("hi") }));
chk("unknown profile 404", 404, await status({ model: "chainaim/cheapest", messages: msg("hi") }));
chk("missing messages 400", 400, await status({ model: "chainaim/auto" }));

console.log("== streaming");
const r3 = await chat({ model: "chainaim/auto", stream: true, max_tokens: 16, messages: msg("Say hello") });
chk("sse content-type", true, (r3.headers.get("content-type") ?? "").includes("text/event-stream"));
chk("stream terminates with [DONE]", true, (await r3.text()).includes("[DONE]"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
