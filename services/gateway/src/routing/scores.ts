/**
 * The scoring table (spec section 6): how well each free model does each kind
 * of task, and the formula that ranks them for one request. Unlisted models
 * are scored from the size in their id.
 */
import { readFileSync } from "node:fs";

export const TASKS = ["chat", "extraction", "rewrite", "code", "reasoning", "tool_use", "long_document"] as const;
export type Task = (typeof TASKS)[number];
export const SPEEDS = ["fast", "medium", "slow"] as const;
export type Speed = (typeof SPEEDS)[number];
/** Tie-break order: the faster speed class wins. */
export const SPEED_RANK: Record<Speed, number> = { fast: 0, medium: 1, slow: 2 };

export type ModelScore = { quality: number; tasks: string[]; speed: Speed; domains: string[] };
export type ScoreTable = {
  version: string;
  weights: { qualityByDifficulty: number[]; taskMatch: number; domainMatch: number; speedWhenEasy: Record<Speed, number> };
  defaults: { qualityBySize: [number, number][]; unknownSizeQuality: number; speedBySize: [number, Speed][]; unknownSizeSpeed: Speed };
  models: Record<string, ModelScore>;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSpeed = (v: unknown): v is Speed => (SPEEDS as readonly unknown[]).includes(v);

/** [minimum size in billions, value] rows, largest first, ending at 0. */
function sizeRows(v: unknown, valueOk: (x: unknown) => boolean): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && valueOk(r[1])) && v[v.length - 1][0] === 0;
}

export function validateScoreTable(raw: unknown): ScoreTable {
  const need = (ok: unknown, message: string): void => {
    if (!ok) throw new Error(`score table: ${message}`);
  };
  need(isObj(raw), "must be a JSON object");
  const t = raw as Record<string, unknown>;
  need(typeof t.version === "string", "version: string required");
  const w = t.weights as Record<string, unknown>;
  need(isObj(w), "weights: object required");
  const q = w.qualityByDifficulty;
  need(Array.isArray(q) && q.length === 5 && q.every((x) => typeof x === "number"), "weights.qualityByDifficulty: five numbers");
  need(typeof w.taskMatch === "number" && typeof w.domainMatch === "number", "weights.taskMatch and weights.domainMatch: numbers");
  const easy = w.speedWhenEasy as Record<string, unknown>;
  need(isObj(easy) && SPEEDS.every((s) => typeof easy[s] === "number"), "weights.speedWhenEasy: a number for fast, medium and slow");
  const d = t.defaults as Record<string, unknown>;
  need(isObj(d), "defaults: object required");
  need(sizeRows(d.qualityBySize, (x) => typeof x === "number"), "defaults.qualityBySize: [minBillions, quality] rows ending at 0");
  need(sizeRows(d.speedBySize, isSpeed), "defaults.speedBySize: [minBillions, speed] rows ending at 0");
  need(typeof d.unknownSizeQuality === "number", "defaults.unknownSizeQuality: number");
  need(isSpeed(d.unknownSizeSpeed), "defaults.unknownSizeSpeed: fast, medium or slow");
  need(isObj(t.models), "models: object required");
  for (const [id, m] of Object.entries(t.models as Record<string, unknown>)) {
    const e = m as Record<string, unknown>;
    need(isObj(m) && typeof e.quality === "number", `models.${id}.quality: number`);
    need(Array.isArray(e.tasks) && e.tasks.every((x) => (TASKS as readonly unknown[]).includes(x)), `models.${id}.tasks: from ${TASKS.join(", ")}`);
    need(isSpeed(e.speed), `models.${id}.speed: fast, medium or slow`);
    need(Array.isArray(e.domains) && e.domains.every((x) => typeof x === "string"), `models.${id}.domains: array of strings`);
  }
  return raw as ScoreTable;
}

export function loadScoreTable(path: string): ScoreTable {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read score table ${path}: ${(e as Error).message}`);
  }
  return validateScoreTable(raw);
}

/** The largest "<number>b" in a model id, e.g. 550 for "nvidia/nemotron-3-ultra-550b-a55b:free". */
export function sizeOf(id: string): number | undefined {
  let best: number | undefined;
  for (const m of id.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)b(?![a-z0-9])/gi)) {
    const n = Number(m[1]);
    if (best === undefined || n > best) best = n;
  }
  return best;
}

/** The table's entry for a model, or one built from the size in its id. */
export function entryFor(table: ScoreTable, id: string): ModelScore {
  const listed = table.models[id];
  if (listed) return listed;
  const size = sizeOf(id);
  const d = table.defaults;
  if (size === undefined) return { quality: d.unknownSizeQuality, speed: d.unknownSizeSpeed, tasks: [], domains: [] };
  const quality = d.qualityBySize.find(([min]) => size >= min)?.[1] ?? d.unknownSizeQuality;
  const speed = d.speedBySize.find(([min]) => size >= min)?.[1] ?? d.unknownSizeSpeed;
  return { quality, speed, tasks: [], domains: [] };
}

export function scoreOf(table: ScoreTable, entry: ModelScore, req: { task: Task; difficulty: number; phi: boolean }): number {
  const w = table.weights;
  return (
    entry.quality * w.qualityByDifficulty[req.difficulty - 1] +
    (entry.tasks.includes(req.task) ? w.taskMatch : 0) +
    (req.phi && entry.domains.includes("health") ? w.domainMatch : 0) +
    (req.difficulty <= 2 ? w.speedWhenEasy[entry.speed] : 0)
  );
}
