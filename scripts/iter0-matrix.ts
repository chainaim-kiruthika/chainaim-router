/**
 * Iteration 0 test matrix: every synthetic prompt x every target (routing
 * profiles and pinned models) through a running chainaim-gateway.
 *
 *   node scripts/iter0-matrix.ts --gateway http://127.0.0.1:8700 [flags]
 *
 * Writes <out>/iter0-<timestamp>.jsonl (one row per call) and a Markdown summary.
 * Use SYNTHETIC prompts only: answers are stored in the report.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: f } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8700" },
    prompts: { type: "string", default: "eval/prompts/iter0.synthetic.jsonl" },
    targets: { type: "string", default: "chainaim/auto,chainaim/eco,chainaim/premium" },
    "max-tokens": { type: "string", default: "96" },
    out: { type: "string", default: "eval/reports" },
    "api-key-env": { type: "string" },
    "answer-chars": { type: "string", default: "160" },
  },
});

type Prompt = { id: string; category: string; prompt: string };
const prompts: Prompt[] = readFileSync(f.prompts!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const targets = f.targets!.split(",").map((s) => s.trim()).filter(Boolean);
const maxTokens = Number(f["max-tokens"]);
const answerChars = Number(f["answer-chars"]);
const key = f["api-key-env"] ? process.env[f["api-key-env"]] : undefined;

type Row = {
  promptId: string; category: string; target: string; status: number; latencyMs: number;
  tier: string | null; servedModel: string | null; deployment: string | null; attempts: number | null;
  completionTokens: number | null; answer: string; error?: string;
};

const rows: Row[] = [];
for (const p of prompts) {
  for (const target of targets) {
    const t0 = performance.now();
    let row: Row;
    try {
      const res = await fetch(`${f.gateway}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: target, max_tokens: maxTokens, temperature: 0, messages: [{ role: "user", content: p.prompt }] }),
      });
      const latencyMs = Math.round(performance.now() - t0);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { completion_tokens?: number }; error?: { message?: string } };
      const h = (n: string) => res.headers.get(n);
      row = {
        promptId: p.id, category: p.category, target, status: res.status, latencyMs,
        tier: h("x-chainaim-tier"), servedModel: h("x-chainaim-model"), deployment: h("x-chainaim-deployment"),
        attempts: h("x-chainaim-attempts") ? Number(h("x-chainaim-attempts")) : null,
        completionTokens: body.usage?.completion_tokens ?? null,
        answer: (body.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim().slice(0, answerChars),
        ...(res.ok ? {} : { error: body.error?.message ?? `HTTP ${res.status}` }),
      };
    } catch (e) {
      row = { promptId: p.id, category: p.category, target, status: 0, latencyMs: Math.round(performance.now() - t0), tier: null,
        servedModel: null, deployment: null, attempts: null, completionTokens: null, answer: "", error: (e as Error).message };
    }
    rows.push(row);
    console.log(`${row.status} ${row.promptId.padEnd(9)} ${target.padEnd(20)} tier=${row.tier ?? "-"} -> ${row.servedModel ?? "-"} ${row.latencyMs}ms`);
  }
}

mkdirSync(f.out!, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonl = join(f.out!, `iter0-${stamp}.jsonl`);
writeFileSync(jsonl, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const ok = rows.filter((r) => r.status === 200);
const byModel = new Map<string, number[]>();
for (const r of ok) byModel.set(r.servedModel!, [...(byModel.get(r.servedModel!) ?? []), r.latencyMs]);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const md = [
  `# Iteration 0 matrix — ${new Date().toISOString()}`,
  "",
  `Gateway ${f.gateway} · ${prompts.length} prompts × ${targets.length} targets = ${rows.length} calls · ${ok.length} succeeded · max_tokens ${maxTokens}`,
  "",
  "| Prompt | Category | Target | Tier | Served by | Attempts | Latency ms | Status |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.promptId} | ${r.category} | ${r.target} | ${r.tier ?? "-"} | ${r.servedModel ?? "-"} | ${r.attempts ?? "-"} | ${r.latencyMs} | ${r.status} |`),
  "",
  "| Model | Calls served | Median latency ms |",
  "| --- | --- | --- |",
  ...[...byModel.entries()].map(([m, xs]) => `| ${m} | ${xs.length} | ${median(xs)} |`),
  "",
].join("\n");
const mdPath = join(f.out!, `iter0-${stamp}.md`);
writeFileSync(mdPath, md);
console.log(`\nwrote ${jsonl}\nwrote ${mdPath}`);
if (ok.length !== rows.length) process.exitCode = 1;
