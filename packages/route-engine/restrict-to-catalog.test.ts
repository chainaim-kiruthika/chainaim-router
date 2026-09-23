import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTING_CONFIG, route } from "./index.js";
import type { RoutingConfig, TierConfig, Tier } from "./types.js";

// ChainAim fork: a host catalog of its own model ids must be the only source of
// candidates when restrictToCatalog is set, even for task types that upstream
// seeds with built-in "evidence" candidates (code_agent, tool_agent, ...).
const OWN = ["local/small", "local/medium"];
const tiers = Object.fromEntries(
  (["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as Tier[]).map((t) => [
    t,
    { primary: OWN[0], fallback: [OWN[1]] } satisfies TierConfig,
  ]),
) as Record<Tier, TierConfig>;
const config: RoutingConfig = {
  ...DEFAULT_ROUTING_CONFIG,
  strategy: "portfolio",
  tiers,
  ecoTiers: null,
  premiumTiers: null,
  agenticTiers: tiers,
  promotions: [],
};
const modelPricing = new Map(OWN.map((m) => [m, { inputPrice: 0.1, outputPrice: 0.2 }]));
const modelCapabilities = Object.fromEntries(
  OWN.map((m) => [m, { contextWindow: 32_768, maxOutputTokens: 4_096, supportsTools: true, supportsVision: false }]),
);
const agentPrompt = "Cancel order B-42 and book the 9am flight to SFO.";
const toolOpts = { hasTools: true, requiresTools: true, toolNames: ["cancel_order", "book_flight"], toolCount: 2 };

describe("restrictToCatalog", () => {
  it("keeps upstream evidence models out of the candidate chain", () => {
    const d = route(agentPrompt, undefined, 512, {
      config, modelPricing, modelCapabilities, restrictToCatalog: true, ...toolOpts,
    });
    expect(OWN).toContain(d.model);
    for (const c of d.candidates ?? []) expect(OWN).toContain(c);
  });

  it("is off by default (upstream behaviour unchanged)", () => {
    const d = route(agentPrompt, undefined, 512, { config, modelPricing, modelCapabilities, ...toolOpts });
    expect((d.candidates ?? []).some((c) => !OWN.includes(c))).toBe(true);
  });

  it("exposes agentRisk on portfolio decisions", () => {
    const d = route(agentPrompt, undefined, 512, {
      config, modelPricing, modelCapabilities, restrictToCatalog: true, ...toolOpts,
    });
    expect(d.agentRisk).toBeDefined();
  });
});
