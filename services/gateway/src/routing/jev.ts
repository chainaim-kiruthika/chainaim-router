/**
 * Jev (typesafe/jev-1.13) through OpenRouter's Decisions API (spec section
 * 6): task, difficulty and whether the request is about a specific person's
 * health, answered as probabilities in about half a second. Jev only reads
 * masked text of requests that are not PHI. The API is alpha, so parsing is
 * strict: any failure returns undefined and the caller uses the rules.
 */
import { TASKS, type Task } from "./scores.ts";

const DIFFICULTY_CRITERIA = ["trivial", "easy", "moderate", "hard", "expert"];
/** The labels a difficulty answer may use, "0" to "4" or a criterion, with the index each stands for. */
const DIFFICULTY_LABELS = new Map<string, number>(DIFFICULTY_CRITERIA.flatMap((c, i): [string, number][] => [[String(i), i], [c, i]]));
const TASK_LABELS: readonly string[] = TASKS;

export const JEV_QUESTIONS = {
  task: {
    type: "choice",
    instructions: "What kind of task is the last user message?",
    criteria: {
      chat: "conversation or a simple question",
      extraction: "pull fields or facts out of text",
      rewrite: "rewrite, translate or summarize given text",
      code: "write, fix or explain code",
      reasoning: "multi-step reasoning, math or planning",
      tool_use: "needs one of the provided tools to act",
      long_document: "work over a long pasted document",
    },
  },
  difficulty: {
    type: "score",
    instructions: "How hard is this request for a language model?",
    criteria: DIFFICULTY_CRITERIA,
  },
  health: {
    type: "noul",
    instructions: "Is this about the health, condition, treatment or medication of a specific person? The person may appear only as a placeholder such as <PERSON_1>.",
    criteria: {
      true: "about a specific person's health",
      false: "not about a specific person's health; general medical questions count as false",
    },
  },
};

export type JevState = { request: string; has_tools: boolean; prompt_tokens: number };
export type JevProbabilities = { task: Record<string, number>; difficulty: Record<string, number>; health: number };
export type JevAnswer = { task: Task; difficulty: number; health: number; probabilities: JevProbabilities };
export type JevResult = JevAnswer & { latencyMs: number };
export type JevOptions = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

export class JevClient {
  private readonly opts: JevOptions;

  constructor(opts: JevOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
  }

  /** One decision; undefined on a timeout, a non-2xx status or an unexpected shape. */
  async classify(state: JevState): Promise<JevResult | undefined> {
    const started = performance.now();
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/alpha/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ model: this.opts.model, state, questions: JEV_QUESTIONS }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined); // cancel() rejects when the stream already failed
        return undefined;
      }
      const answer = parseJevAnswers(await res.json());
      return answer && { ...answer, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return undefined;
    }
  }
}

function probabilities(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([, p]) => typeof p === "number" && p >= 0 && p <= 1)) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

function mostLikely(p: Record<string, number>): string {
  return Object.entries(p).reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

/** The entries whose key is a known label. The ledger records these maps, and a key the model made up could carry any text. */
function knownOnly(p: Record<string, number> | undefined, known: (label: string) => boolean): Record<string, number> {
  return Object.fromEntries(Object.entries(p ?? {}).filter(([label]) => known(label)));
}

type Answers = Partial<Record<"task" | "difficulty" | "health", Record<string, unknown> | undefined>>;

/**
 * The three answers as the gateway uses them, or undefined when anything is
 * missing or out of range. A probability map the answer is read from must
 * have a known label on top, so it never ends up empty once unknown labels
 * are dropped.
 */
export function parseJevAnswers(body: unknown): JevAnswer | undefined {
  const answers = (body as { answers?: Answers } | null)?.answers;
  if (typeof answers !== "object" || answers === null) return undefined;

  const taskProbs = probabilities(answers.task?.probabilities);
  const choice = typeof answers.task?.choice === "string" ? answers.task.choice : taskProbs ? mostLikely(taskProbs) : undefined;
  if (choice === undefined || !TASK_LABELS.includes(choice)) return undefined;

  const difficultyProbs = probabilities(answers.difficulty?.probabilities);
  const score = answers.difficulty?.score;
  let index = Number.NaN;
  if (difficultyProbs) index = DIFFICULTY_LABELS.get(mostLikely(difficultyProbs)) ?? Number.NaN;
  else if (typeof score === "number") index = Math.round(score);
  if (!Number.isInteger(index) || index < 0 || index > 4) return undefined;

  const health = answers.health?.noul;
  if (typeof health !== "number" || !Number.isFinite(health) || health < 0 || health > 1) return undefined;

  const recorded = {
    task: knownOnly(taskProbs, (label) => TASK_LABELS.includes(label)),
    difficulty: knownOnly(difficultyProbs, (label) => DIFFICULTY_LABELS.has(label)),
    health,
  };
  return { task: choice as Task, difficulty: index + 1, health, probabilities: recorded };
}
