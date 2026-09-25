/**
 * The three paid routes: price, description and Bazaar discovery metadata
 * (spec section 9). Every example here is synthetic.
 */
import { declareDiscoveryExtension } from "@x402-avm/extensions";
import { CHALLENGE_TAG, type PaywallConfig } from "./config.ts";

export type PaidRoute = { key: string; path: string; price: string; description: string; discovery: Record<string, unknown> };

const EXAMPLE_TEXT = "Patient Jane Roe, MRN 991122, was diagnosed with diabetes.";
const textSchema = (verb: string) => ({
  type: "object",
  properties: { text: { type: "string", minLength: 1, maxLength: 20000, description: `Text to ${verb}, 1 to 20,000 characters` } },
  required: ["text"],
});

export const PAID_ROUTES: readonly PaidRoute[] = [
  {
    key: "POST /v1/privacy/scan",
    path: "/v1/privacy/scan",
    price: "$0.002",
    description: "Finds personal, health and card data in text and returns entity types, positions and the data class. No model is called.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: { text: EXAMPLE_TEXT },
      inputSchema: textSchema("scan"),
      output: {
        example: {
          decisionId: "7d0c2a1e-5b7f-4c1e-9a53-2f6f0b8e41aa",
          dataClass: "PHI",
          found: ["PHI", "PII"],
          entities: [
            { type: "PERSON", start: 8, end: 16, score: 0.85 },
            { type: "MEDICAL_RECORD", start: 22, end: 28, score: 0.45 },
            { type: "HEALTH_TERM", start: 34, end: 43, score: 1 },
            { type: "HEALTH_TERM", start: 49, end: 57, score: 1 },
          ],
          counts: { PERSON: 1, MEDICAL_RECORD: 1, HEALTH_TERM: 2 },
          policy: { dataCollection: "deny", cardDataRemoved: false },
        },
      },
    }),
  },
  {
    key: "POST /v1/privacy/mask",
    path: "/v1/privacy/mask",
    price: "$0.003",
    description: "Replaces personal and health identifiers with numbered placeholders and removes card numbers. Returns the masked text and the map to restore it.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: { text: EXAMPLE_TEXT },
      inputSchema: textSchema("mask"),
      output: {
        example: {
          decisionId: "0b9e5f3c-2d41-4a8e-b6c7-91d2e8f4a310",
          dataClass: "PHI",
          found: ["PHI", "PII"],
          maskedText: "Patient <PERSON_1>, MRN <MEDICAL_RECORD_1>, was diagnosed with diabetes.",
          map: { "<PERSON_1>": "Jane Roe", "<MEDICAL_RECORD_1>": "991122" },
          counts: { PERSON: 1, MEDICAL_RECORD: 1, HEALTH_TERM: 2 },
          cardsRemoved: 0,
        },
      },
    }),
  },
  {
    key: "POST /v1/chat/completions",
    path: "/v1/chat/completions",
    price: "$0.01",
    description: "OpenAI-compatible private chat. Masks the conversation, routes it with Jev across free models under a data policy set by what it contains, and restores the answer.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        model: "chainaim/auto",
        messages: [{ role: "user", content: "Write a two-line reminder to Jane Roe (jane.roe@example.com) about Friday's 10:00 meeting." }],
        max_tokens: 200,
      },
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            minItems: 1,
            description: "OpenAI chat messages; text only, at most 48,000 characters in total",
            items: { type: "object", properties: { role: { type: "string" }, content: { description: "a string, or an array of text parts" } }, required: ["role"] },
          },
          model: { type: "string", description: "chainaim/auto, or a free model id from GET /v1/models" },
          max_tokens: { type: "integer", minimum: 1, maximum: 1024 },
          stream: { type: "boolean" },
          tools: { type: "array" },
          response_format: { type: "object" },
        },
        required: ["messages"],
      },
      output: {
        example: {
          id: "gen-1790000000-example",
          object: "chat.completion",
          model: "qwen/qwen3.8-27b:free",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hi Jane Roe, a reminder that we meet on Friday at 10:00. Reply to jane.roe@example.com if that time doesn't work." },
              finish_reason: "stop",
            },
          ],
        },
      },
    }),
  },
];

export type RouteEntry = {
  accepts: { scheme: "exact"; price: string; network: string; payTo: string; extra: { tag: string } }[];
  description: string;
  mimeType: "application/json";
  resource?: string;
  extensions: Record<string, unknown>;
};

/** The route table for paymentMiddleware: one exact USDC price per route, the challenge tag, and the Bazaar metadata. */
export function routesConfig(config: PaywallConfig): Record<string, RouteEntry> {
  return Object.fromEntries(
    PAID_ROUTES.map((r): [string, RouteEntry] => [
      r.key,
      {
        accepts: [{ scheme: "exact", price: r.price, network: config.network, payTo: config.payTo, extra: { tag: CHALLENGE_TAG } }],
        description: r.description,
        mimeType: "application/json",
        ...(config.publicBaseUrl ? { resource: `${config.publicBaseUrl}${r.path}` } : {}),
        extensions: r.discovery,
      },
    ]),
  );
}
