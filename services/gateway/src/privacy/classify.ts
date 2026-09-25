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

/** Occurrences per entity type, e.g. { PERSON: 2, HEALTH_TERM: 1 }. */
export function countTypes(entities: readonly { type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}
