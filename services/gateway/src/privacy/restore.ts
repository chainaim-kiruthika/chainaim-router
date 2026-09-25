/**
 * Restore: put the original values back in place of <TYPE_N> placeholders
 * (spec section 5, "Restore"). A placeholder with no map entry stays as it is
 * and is counted, so the ledger shows how often a model invents one.
 */

/** <TYPE_N>, in any case, with spaces allowed inside the brackets. */
const PLACEHOLDER = /<\s*([A-Za-z][A-Za-z_]*?_\d+)\s*>/g;

export type RestoreStats = { unresolved: number };

/** @param json the text is inside a JSON string (tool-call arguments), so values are JSON-escaped */
export function restoreText(text: string, map: Readonly<Record<string, string>>, stats: RestoreStats, json = false): string {
  return text.replace(PLACEHOLDER, (whole: string, name: string) => {
    const value = map[`<${name.toUpperCase()}>`];
    if (value === undefined) {
      stats.unresolved++;
      return whole;
    }
    return json ? JSON.stringify(value).slice(1, -1) : value;
  });
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Restore a chat completion in place: content, reasoning, refusal and tool-call arguments of every choice. */
export function restoreCompletion(completion: unknown, map: Readonly<Record<string, string>>, stats: RestoreStats): void {
  const choices = isObj(completion) ? completion.choices : undefined;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const message = isObj(choice) ? choice.message : undefined;
    if (!isObj(message)) continue;
    for (const field of ["content", "reasoning", "refusal"]) {
      const v = message[field];
      if (typeof v === "string") message[field] = restoreText(v, map, stats);
    }
    if (!Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const fn = isObj(call) ? call.function : undefined;
      if (isObj(fn) && typeof fn.arguments === "string") fn.arguments = restoreText(fn.arguments, map, stats, true);
    }
  }
}
