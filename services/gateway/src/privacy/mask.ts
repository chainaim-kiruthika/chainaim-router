/**
 * Masking: replace detected values with numbered placeholders the caller can
 * restore, and remove card numbers for good (spec section 5, "Placeholders").
 */
import { isCard, isMasked, type Detected } from "./entities.ts";

export const CARD_REMOVED = "[CARD REMOVED]";

/**
 * One Masker per request. Numbering and the map are shared by every text it
 * masks, so call mask() in reading order (messages in order, left to right).
 * The same value (after trimming; emails ignoring case) always gets the same
 * placeholder, and the map records the first spelling seen. The map lives
 * only as long as this object.
 */
export class Masker {
  /** placeholder -> original value */
  readonly map: Record<string, string> = {};
  cardsRemoved = 0;
  private readonly byValue = new Map<string, string>();
  private readonly lastNumber = new Map<string, number>();

  /** @param entities non-overlapping and sorted by start, as PresidioClient.analyze returns them */
  mask(text: string, entities: readonly Detected[]): string {
    let out = "";
    let at = 0;
    for (const e of entities) {
      const value = text.slice(e.start, e.end);
      out += text.slice(at, e.start);
      if (isCard(e.type)) {
        out += CARD_REMOVED;
        this.cardsRemoved++;
      } else if (isMasked(e.type)) {
        out += this.placeholder(e.type, value);
      } else {
        out += value; // health terms stay: the model needs them
      }
      at = e.end;
    }
    return out + text.slice(at);
  }

  private placeholder(type: string, value: string): string {
    const trimmed = value.trim();
    const key = `${type}\u0000${type === "EMAIL_ADDRESS" ? trimmed.toLowerCase() : trimmed}`;
    let p = this.byValue.get(key);
    if (p === undefined) {
      const n = (this.lastNumber.get(type) ?? 0) + 1;
      this.lastNumber.set(type, n);
      p = `<${type}_${n}>`;
      this.byValue.set(key, p);
      this.map[p] = value;
    }
    return p;
  }
}

/** A chat message as the gateway forwards it: these fields only, and text content only. */
export type TextPart = { type: "text"; text: string };
export type ToolCall = { id?: string; type: "function"; function: { name: string; arguments: string } };
export type Message = { role: string; content?: string | TextPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string };

/** Receives each text and a context prefix that Presidio reads with it (a JSON key); returns the replacement text. */
export type TextMapper = (text: string, context: string) => string;

/**
 * Rebuild a conversation with every text field passed through fn, in reading
 * order: messages in order; in each, the content (a string or text parts),
 * then each tool call's arguments. Arguments that are JSON are split into
 * their keys and their string and number values, so a masked value can never
 * break JSON escaping; a masked number comes back as a string. Each key is a
 * text of its own, visited before its value, because a model can put an
 * identifier in a key; the value is read with the original key as context.
 * Two keys that mask to the same placeholder become one key (that object
 * loses a value; nothing leaks). Arguments holding an integer that JSON.parse
 * would round are scanned whole instead. Fields other than role, content,
 * tool_calls and tool_call_id are dropped, so no unscanned text can ride along.
 */
export function mapConversation(messages: readonly Message[], fn: TextMapper): Message[] {
  return messages.map((m) => {
    const out: Message = { role: m.role };
    if (typeof m.content === "string") out.content = fn(m.content, "");
    else if (Array.isArray(m.content)) out.content = m.content.map((p): TextPart => ({ type: "text", text: fn(p.text, "") }));
    else if (m.content === null) out.content = null;
    if (m.tool_calls) {
      out.tool_calls = m.tool_calls.map((c): ToolCall => ({
        ...(c.id === undefined ? {} : { id: c.id }),
        type: "function",
        function: { name: c.function.name, arguments: mapArguments(c.function.arguments, fn) },
      }));
    }
    if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

function mapArguments(args: string, fn: TextMapper): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return fn(args, "");
  }
  // A 16 to 19 digit card number sent as a bare number would reach detection with changed digits.
  if (hasUnsafeInteger(parsed)) return fn(args, "");
  return JSON.stringify(mapJson(parsed, "", fn));
}

/** True when the value holds an integer beyond 2^53, which JSON.parse has rounded. */
function hasUnsafeInteger(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasUnsafeInteger);
  if (typeof value === "object" && value !== null) return Object.values(value).some(hasUnsafeInteger);
  return false;
}

function mapJson(value: unknown, key: string, fn: TextMapper): unknown {
  const context = key ? `${key}: ` : "";
  if (typeof value === "string") return fn(value, context);
  if (typeof value === "number") {
    const text = String(value);
    const mapped = fn(text, context);
    return mapped === text ? value : mapped;
  }
  if (Array.isArray(value)) return value.map((v) => mapJson(v, key, fn));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        const outKey = fn(k, ""); // the key first: reading order
        return [outKey, mapJson(v, k, fn)];
      }),
    );
  }
  return value;
}

/**
 * Entities found in `context + text`, moved to offsets within `text`. A span
 * that lies entirely in the context is dropped; one that crosses into the
 * value is cut to the value.
 */
export function withinValue(text: string, found: readonly Detected[], contextLength: number): Detected[] {
  const out: Detected[] = [];
  for (const d of found) {
    let start = Math.max(d.start - contextLength, 0);
    const end = Math.min(d.end - contextLength, text.length);
    while (start < end && /\s/.test(text[start])) start++;
    if (end > start) out.push({ ...d, start, end });
  }
  return out;
}
