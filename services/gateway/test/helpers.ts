/**
 * Shared test helpers.
 */
import { KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { CARD_REMOVED } from "../src/privacy/mask.ts";

/** A corpus text as restore gives it back: card numbers stay removed. */
export function withCardsRemoved(text: string): string {
  let out = text;
  for (const k of KNOWN_VALUES) if (k.type === "CREDIT_CARD") out = out.replaceAll(k.value, CARD_REMOVED);
  return out;
}
