/**
 * Entity types -> data classes and the data policy (spec section 5, "Classes").
 */
import { isCard, isHealthTerm, isMedicalId, isPersonal } from "./entities.ts";

export type DataClass = "PHI" | "PCI" | "PII" | "none";
export type FoundClass = Exclude<DataClass, "none">;
export type Policy = { dataCollection: "allow" | "deny"; cardDataRemoved: boolean };
export type Classes = { found: FoundClass[]; dataClass: DataClass; policy: Policy };

/**
 * @param types entity types found in one text (scan, mask) or in a whole conversation (chat)
 * @param healthFlag Jev judged the chat to be about a specific person's health
 */
export function classify(types: Iterable<string>, healthFlag = false): Classes {
  let personal = false;
  let card = false;
  let medicalId = false;
  let healthTerm = false;
  for (const t of types) {
    personal ||= isPersonal(t);
    card ||= isCard(t);
    medicalId ||= isMedicalId(t);
    healthTerm ||= isHealthTerm(t);
  }
  const phi = medicalId || (healthTerm && personal) || healthFlag;
  const found: FoundClass[] = [];
  if (phi) found.push("PHI");
  if (card) found.push("PCI");
  if (personal) found.push("PII");
  return { found, dataClass: found[0] ?? "none", policy: { dataCollection: phi ? "deny" : "allow", cardDataRemoved: card } };
}

/** <C_TYPE_n> in any case, as the client-side masker (services/paywall/scripts/client-mask.ts) writes it. The server's own <TYPE_n> does not match. */
const CLIENT_PLACEHOLDER = /<\s*C_([A-Za-z][A-Za-z_]*?)_\d+\s*>/gi;
/** What the client-side masker writes in place of a card number. */
const CLIENT_CARD_REMOVED = "[CARD REMOVED]";

/**
 * Entity types a client already masked before sending: each <C_TYPE_n> counts
 * as a TYPE found, and [CARD REMOVED] as a card. Added to what Presidio finds,
 * so masking on the user's machine can only make the data policy stricter,
 * never looser: a masked medical record number is still a medical ID.
 */
export function clientPlaceholderTypes(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(CLIENT_PLACEHOLDER)) out.push(m[1].toUpperCase());
    if (text.includes(CLIENT_CARD_REMOVED)) out.push("CREDIT_CARD");
  }
  return out;
}

/** Occurrences per entity type, e.g. { PERSON: 2, HEALTH_TERM: 1 }. */
export function countTypes(entities: readonly { type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}
