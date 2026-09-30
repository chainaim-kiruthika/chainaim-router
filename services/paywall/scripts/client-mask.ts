/**
 * Masking that runs on the user's own machine, before anything is sent to
 * ChainAim. Pattern checks only, no language model: card numbers (Luhn),
 * Aadhaar, PAN, IFSC, e-mail, Indian mobile numbers, bank account and
 * medical record numbers next to a label, and names after a label such as
 * "Patient:", "Name:" (at the start of a line) or "Dr.".
 *
 * Values become <C_TYPE_n>; the C_ keeps them apart from the server's own
 * <TYPE_n>, so the two never collide when the server masks something this
 * file missed. Card numbers become [CARD REMOVED] and are never restored.
 * The same value always gets the same placeholder.
 *
 * When unsure it masks: masking too much costs answer quality, masking too
 * little leaks. No dependencies, so the same logic can move to a web page.
 */

export type Found = { type: string; start: number; end: number };
export type MaskOptions = {
  /** Mask names found after a label (default true). */
  names?: boolean;
};
export type Masked = { masked: string; map: Record<string, string>; counts: Record<string, number>; cardsRemoved: number };

export const CARD_REMOVED = "[CARD REMOVED]";
export const PREFIX = "C_";

/** Words that, just before a number, make it a bank account or a medical record number. */
const BANK_WORDS = ["account", "a/c", "acct", "ac no", "acc no"];
const MEDICAL_WORDS = ["mrn", "medical", "record", "uhid", "patient id", "hospital no", "ip no", "op no", "reg no"];
/** How many characters before a number are searched for those words. */
const CONTEXT_WINDOW = 40;

/**
 * A label a name follows. "Name" counts only at the start of a line, so
 * "Drug Name: Metformin" does not mask the drug.
 */
const LABEL = /(?:\bPatient(?:'s)?(?:[ \t]+Name)?|^[ \t]*Name|\bS\/O|\bD\/O|\bW\/O|\bC\/O|\bMrs|\bMiss|\bMs|\bMr|\bDr|\bShri|\bSmt)(?=[\s.:-])\.?[ \t]*[:-]?[ \t]*/gim;
/** One capitalised word of a name. */
const NAME_TOKEN = /[A-Z][a-zA-Z'-]*/y;
/** Between two words of one name: spaces or tabs, after an optional dot (initials). Never a line break. */
const NAME_GAP = /\.?[ \t]+/y;
/** Capitalised words that end a name: form field labels, not names. */
const NOT_NAME = new Set(["ID", "NO", "NUMBER", "AGE", "SEX", "GENDER", "DATE", "DOB", "MRN", "UHID", "ADDRESS", "PHONE", "MOBILE", "EMAIL", "HOSPITAL", "DIAGNOSIS", "RX", "OF", "THE"]);
/** At most this many words in one name. */
const MAX_NAME_WORDS = 4;

/** Sensitive values in `text`, non-overlapping and sorted by start. */
export function detect(text: string, options: MaskOptions = {}): Found[] {
  const found: Found[] = [];
  const add = (type: string, start: number, end: number): void => {
    if (end > start) found.push({ type, start, end });
  };
  const each = (re: RegExp, type: string, keep: (value: string, start: number) => boolean = () => true): void => {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      if (keep(m[0], start)) add(type, start, start + m[0].length);
    }
  };
  const after = (words: readonly string[]) => (_value: string, start: number): boolean => {
    const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start).toLowerCase();
    return words.some((w) => before.includes(w));
  };

  each(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, "CREDIT_CARD", (v) => luhn(v.replace(/\D/g, "")));
  each(/(?<!\d)[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?!\d)/g, "IN_AADHAAR"); // any 12-digit number of this shape: over-masking is safe
  each(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "IN_PAN");
  each(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, "IN_IFSC");
  each(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "EMAIL_ADDRESS");
  each(/(?<![\w+])(?:\+?91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?!\d)/g, "PHONE_NUMBER");
  each(/(?<!\d)\d{9,18}(?!\d)/g, "IN_BANK_ACCOUNT", after(BANK_WORDS));
  each(/\b[A-Z]{0,3}\d{6,10}\b/g, "MEDICAL_RECORD", after(MEDICAL_WORDS));
  if (options.names !== false) found.push(...names(text));
  return resolveOverlaps(found);
}

/** Names after a label, then every other whole-word occurrence of those names and of their longer words. */
function names(text: string): Found[] {
  const values = new Set<string>();
  for (const m of text.matchAll(LABEL)) {
    const span = nameAt(text, (m.index ?? 0) + m[0].length);
    if (!span) continue;
    const name = text.slice(span[0], span[1]);
    values.add(name);
    for (const word of name.split(/[\s.]+/)) if (word.length >= 3 && !NOT_NAME.has(word.toUpperCase())) values.add(word);
  }
  const out: Found[] = [];
  for (const v of values) {
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z])${escapeRegExp(v)}(?![A-Za-z])`, "g"))) {
      const start = m.index ?? 0;
      out.push({ type: "PERSON", start, end: start + v.length });
    }
  }
  return out;
}

/** The name starting at `at`: up to MAX_NAME_WORDS capitalised words on one line. */
function nameAt(text: string, at: number): [number, number] | undefined {
  let pos = at;
  let start = -1;
  let end = -1;
  for (let words = 0; words < MAX_NAME_WORDS; words++) {
    NAME_TOKEN.lastIndex = pos;
    const token = NAME_TOKEN.exec(text);
    if (!token || NOT_NAME.has(token[0].toUpperCase())) break;
    if (start < 0) start = token.index;
    end = token.index + token[0].length;
    NAME_GAP.lastIndex = end;
    const gap = NAME_GAP.exec(text);
    if (!gap) break;
    pos = end + gap[0].length;
  }
  return start < 0 ? undefined : [start, end];
}

/** Overlapping spans: the longer wins, then the earlier. The result is sorted by start. */
function resolveOverlaps(spans: readonly Found[]): Found[] {
  const ranked = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Found[] = [];
  for (const s of ranked) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}

/** Replace each found value; `found` must be non-overlapping and sorted by start, as detect() returns it. */
export function mask(text: string, found: readonly Found[]): Masked {
  const map: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const byValue = new Map<string, string>();
  const lastNumber = new Map<string, number>();
  let cardsRemoved = 0;
  let out = "";
  let at = 0;
  for (const f of found) {
    const value = text.slice(f.start, f.end);
    out += text.slice(at, f.start);
    counts[f.type] = (counts[f.type] ?? 0) + 1;
    if (f.type === "CREDIT_CARD") {
      out += CARD_REMOVED;
      cardsRemoved++;
    } else {
      const trimmed = value.trim();
      const key = `${f.type}\u0000${f.type === "EMAIL_ADDRESS" ? trimmed.toLowerCase() : trimmed}`;
      let placeholder = byValue.get(key);
      if (placeholder === undefined) {
        const n = (lastNumber.get(f.type) ?? 0) + 1;
        lastNumber.set(f.type, n);
        placeholder = `<${PREFIX}${f.type}_${n}>`;
        byValue.set(key, placeholder);
        map[placeholder] = value;
      }
      out += placeholder;
    }
    at = f.end;
  }
  return { masked: out + text.slice(at), map, counts, cardsRemoved };
}

/** detect() then mask(). */
export function maskText(text: string, options: MaskOptions = {}): Masked {
  return mask(text, detect(text, options));
}

/** <C_TYPE_n>, in any case, with spaces allowed inside the brackets. The server's own <TYPE_n> is left alone. */
const CLIENT_PLACEHOLDER = /<\s*(C_[A-Za-z][A-Za-z_]*?_\d+)\s*>/gi;

/** Put the original values back; a placeholder not in the map stays as it is and is counted. */
export function restore(text: string, map: Readonly<Record<string, string>>): { text: string; unresolved: number } {
  let unresolved = 0;
  const out = text.replace(CLIENT_PLACEHOLDER, (whole: string, name: string) => {
    const value = map[`<${name.toUpperCase()}>`];
    if (value === undefined) {
      unresolved++;
      return whole;
    }
    return value;
  });
  return { text: out, unresolved };
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
