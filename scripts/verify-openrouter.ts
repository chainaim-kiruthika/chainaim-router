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
