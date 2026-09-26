/**
 * Task classification for chat (spec section 6): Jev first, the route
 * engine's rules when Jev is off, fails, answers badly, or the request is
 * already PHI (D9: Jev never sees health data).
 */
import { classifyByRules, DEFAULT_ROUTING_CONFIG, inferToolRequirement } from "../../../../packages/route-engine/dist/index.js";
import type { JevClient, JevProbabilities, JevState } from "./jev.ts";
import type { Task } from "./scores.ts";

export type TaskInput = {
  /** Masked system and developer text. */
  system: string;
  /** Masked text of every other message, in order. */
  turns: { role: string; text: string }[];
  lastUser: string;
  hasTools: boolean;
  toolChoice: unknown;
  promptTokens: number;
};

export type TaskClass = {
  classifier: "jev" | "rules";
  task: Task;
  difficulty: number;
  health: number | null;
  jev: { probabilities: JevProbabilities; latencyMs: number } | null;
};

const TIER_DIFFICULTY: Record<string, number> = { SIMPLE: 1, MEDIUM: 3, COMPLEX: 4, REASONING: 5 };

/** The rules fallback: no network, no health flag. */
export function classifyWithRules(input: TaskInput): TaskClass {
  const system = input.system || undefined;
  const r = classifyByRules(input.lastUser, system, input.promptTokens, DEFAULT_ROUTING_CONFIG.scoring);
  const difficulty = r.tier ? TIER_DIFFICULTY[r.tier] : 3;
  const code = r.dimensions?.find((d: { name: string }) => d.name === "codePresence")?.score ?? 0;
  let task: Task = "chat";
  if (input.hasTools && inferToolRequirement(input.lastUser, system, input.toolChoice)) task = "tool_use";
  else if (input.promptTokens > 8000) task = "long_document";
  else if (code > 0) task = "code";
  else if (r.tier === "REASONING") task = "reasoning";
  return { classifier: "rules", task, difficulty, health: null, jev: null };
}

/** What Jev reads: the system prompt's first 1,000 characters and the last three turns, at most 7,000 characters. */
export function jevState(input: TaskInput): JevState {
  const turns = input.turns
    .slice(-3)
    .map((t) => `[${t.role}]\n${t.text}`)
    .join("\n\n");
  const recent = turns.length > 7000 ? turns.slice(-7000) : turns;
  const system = input.system ? `[system]\n${input.system.slice(0, 1000)}\n\n` : "";
  return { request: system + recent, has_tools: input.hasTools, prompt_tokens: input.promptTokens };
}

export async function classifyTask(input: TaskInput, jev: JevClient | undefined, phi: boolean): Promise<TaskClass> {
  if (jev && !phi) {
    const j = await jev.classify(jevState(input));
    if (j) return { classifier: "jev", task: j.task, difficulty: j.difficulty, health: j.health, jev: { probabilities: j.probabilities, latencyMs: j.latencyMs } };
  }
  return classifyWithRules(input);
}
