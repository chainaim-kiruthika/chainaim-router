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
