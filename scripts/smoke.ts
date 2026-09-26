/**
 * Smoke-test a running chainaim-gateway.
 *
 *   node scripts/smoke.ts [--gateway http://127.0.0.1:8700] [--api-key-env NAME] [--chat]
 *
 * Checks liveness, the model list, scan and mask on synthetic text, and with
 * --chat one private chat call. Works against the stub Presidio or a real one.
 * Exit code 0 = all checks passed.
 */
import { parseArgs } from "node:util";

const { values: f } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8700" },
    "api-key-env": { type: "string" },
    chat: { type: "boolean", default: false },
    timeout: { type: "string", default: "120000" },
  },
});
const G = f.gateway!.replace(/\/+$/, "");
const key = f["api-key-env"] ? process.env[f["api-key-env"]] : undefined;
const timeoutMs = Number(f.timeout);
const TEXT = "Patient Jane Roe, MRN 991122, was diagnosed with diabetes."; // synthetic

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail: unknown): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `  ok   ${label}` : `  FAIL ${label}: ${JSON.stringify(detail)}`);
}
const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) });
const post = (path: string, body: unknown) => fetch(`${G}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });

console.log(`smoke: ${G}\n`);
const health = await fetch(`${G}/healthz`);
check("healthz is 200 (Presidio answers)", health.status === 200, health.status);
const models = await (await fetch(`${G}/v1/models`, { headers: headers() })).json();
check("the model list starts with chainaim/auto", models.data?.[0]?.id === "chainaim/auto", models.data?.[0]);
const scan = await (await post("/v1/privacy/scan", { text: TEXT })).json();
check("scan says PHI with a no-collection policy", scan.dataClass === "PHI" && scan.policy?.dataCollection === "deny", scan.dataClass);
const mask = await (await post("/v1/privacy/mask", { text: TEXT })).json();
check("mask hides the name", typeof mask.maskedText === "string" && !mask.maskedText.includes("Jane Roe"), mask.maskedText);
check("mask's map holds the name", Object.values(mask.map ?? {}).includes("Jane Roe"), mask.map);
if (f.chat) {
  const r = await post("/v1/chat/completions", { messages: [{ role: "user", content: "Say hello to Jane Roe in five words." }], max_tokens: 64 });
  const j = await r.json();
  check("chat answers 200", r.status === 200, j.error ?? r.status);
  check("chat names the model that served it", (r.headers.get("x-chainaim-model") ?? "") !== "", r.headers.get("x-chainaim-model"));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
