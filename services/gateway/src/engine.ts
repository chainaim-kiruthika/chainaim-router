/**
 * Decision step: OpenAI-style chat request -> ordered chain of catalog models.
 *
 * The gateway never ranks models itself. It extracts request features, builds
 * route-engine options from the catalog, and asks @chainaim/route-engine.
 */
import {
  DEFAULT_ROUTING_CONFIG,
  getFallbackChain,
  inferToolRequirement,
  route,
} from "../../../packages/route-engine/dist/index.js";
import type { RoutingConfig, RoutingDecision } from "../../../packages/route-engine/dist/index.js";
import { PROFILES, TIERS, type Catalog, type Profile, type Tier, type TierChains } from "./catalog.ts";

export const PROFILE_PREFIX = "chainaim/";
export type Strategy = "rules" | "portfolio";

type ChatContentPart = { type?: string; text?: string };
type ChatMessage = { role?: string; content?: string | ChatContentPart[] | null };
export type ChatRequest = {
  model?: string;
  messages?: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type?: string };
  stream?: boolean;
  [k: string]: unknown;
};

export type RequestFeatures = {
  prompt: string;
  systemPrompt: string | undefined;
  maxOutputTokens: number;
  hasTools: boolean;
  requiresTools: boolean;
  toolNames: string[];
  hasVision: boolean;
  requiresStructuredOutput: boolean;
  promptChars: number;
};

export type Decision = {
  /** "profile" when routed by the engine, "pinned" when the client named a catalog model. */
  mode: "profile" | "pinned";
  profile?: Profile;
  chain: string[];
  tier?: string;
  taskType?: string;
  confidence?: number;
  agentRisk?: string;
  reasoning?: string;
  strategy?: Strategy;
  excluded: string[];
};

export class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  }
  return "";
}

export function extractFeatures(req: ChatRequest, defaultMaxTokens: number): RequestFeatures {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new RequestError(400, "messages: non-empty array required");
  }
  const system = req.messages.filter((m) => m?.role === "system" || m?.role === "developer").map((m) => textOf(m.content));
  const users = req.messages.filter((m) => m?.role === "user");
  const lastUser = users.length > 0 ? textOf(users[users.length - 1].content) : "";
  const hasVision = req.messages.some(
    (m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === "image_url" || p?.type === "input_image"),
  );
  const tools = Array.isArray(req.tools) ? req.tools : [];
  const toolNames = tools
    .map((t) => (t as { function?: { name?: unknown } })?.function?.name)
    .filter((n): n is string => typeof n === "string");
  const hasTools = tools.length > 0 && req.tool_choice !== "none";
  const systemPrompt = system.length > 0 ? system.join("\n") : undefined;
  const requested = req.max_completion_tokens ?? req.max_tokens;
  const maxOutputTokens = Number.isInteger(requested) && (requested as number) > 0 ? (requested as number) : defaultMaxTokens;
  const rf = req.response_format?.type;
  return {
    prompt: lastUser,
    systemPrompt,
    maxOutputTokens,
    hasTools,
    requiresTools: hasTools && inferToolRequirement(lastUser, systemPrompt, req.tool_choice),
    toolNames,
    hasVision,
    requiresStructuredOutput: rf === "json_schema" || rf === "json_object",
    promptChars: req.messages.reduce((n, m) => n + textOf(m?.content).length, 0),
  };
}

function toTierConfigs(chains: TierChains) {
  return Object.fromEntries(
    TIERS.map((t: Tier) => [t, { primary: chains[t][0], fallback: chains[t].slice(1) }]),
  ) as RoutingConfig["tiers"];
}

export type EngineOptions = { strategy: Strategy; defaultProfile: Profile; defaultMaxTokens: number };

export class Engine {
  readonly catalog: Catalog;
  readonly opts: EngineOptions;
  private readonly config: RoutingConfig;
  private readonly modelPricing: Map<string, { inputPrice: number; outputPrice: number }>;
  private readonly modelCapabilities: Record<string, { contextWindow: number; maxOutputTokens: number; supportsTools: boolean; supportsVision: boolean }>;
  private readonly ids: Set<string>;

  constructor(catalog: Catalog, opts: EngineOptions) {
    this.catalog = catalog;
    this.opts = opts;
    this.ids = new Set(catalog.models.map((m) => m.id));
    this.modelPricing = new Map(catalog.models.map((m) => [m.id, { inputPrice: m.pricing.inputPerM, outputPrice: m.pricing.outputPerM }]));
    this.modelCapabilities = Object.fromEntries(catalog.models.map((m) => [m.id, { ...m.capabilities }]));
    // Keep upstream's classifier/scoring/overrides; replace every model list with ours.
    this.config = {
      ...DEFAULT_ROUTING_CONFIG,
      version: `chainaim-${catalog.version}`,
      strategy: opts.strategy,
      shadow: undefined,
      tiers: toTierConfigs(catalog.profiles.auto),
      ecoTiers: toTierConfigs(catalog.profiles.eco),
      premiumTiers: toTierConfigs(catalog.profiles.premium),
      agenticTiers: catalog.agentic ? toTierConfigs(catalog.agentic) : null,
      promotions: [],
    };
  }

  /** Resolve the requested model name to a routing profile, a pinned model, or an error. */
  resolveTarget(model: string | undefined): { profile: Profile } | { pinned: string } {
    if (model === undefined || model === "" ) return { profile: this.opts.defaultProfile };
    if (model.startsWith(PROFILE_PREFIX)) {
      const p = model.slice(PROFILE_PREFIX.length);
      if ((PROFILES as readonly string[]).includes(p)) return { profile: p as Profile };
      throw new RequestError(404, `unknown routing profile ${model}; use one of ${PROFILES.map((x) => PROFILE_PREFIX + x).join(", ")}`);
    }
    if (this.ids.has(model)) return { pinned: model };
    throw new RequestError(404, `unknown model ${model}`);
  }

  /**
   * @param unavailable models with no healthy deployment right now (from the pool)
   */
  decide(req: ChatRequest, unavailable: readonly string[]): { decision: Decision; features: RequestFeatures } {
    const features = extractFeatures(req, this.opts.defaultMaxTokens);
    const target = this.resolveTarget(req.model);
    if ("pinned" in target) {
      return { features, decision: { mode: "pinned", chain: [target.pinned], excluded: [...unavailable] } };
    }
    const d: RoutingDecision = route(features.prompt, features.systemPrompt, features.maxOutputTokens, {
      config: this.config,
      modelPricing: this.modelPricing,
      modelCapabilities: this.modelCapabilities,
      routingProfile: target.profile,
      hasTools: features.hasTools,
      requiresTools: features.requiresTools,
      toolCount: features.toolNames.length,
      toolNames: features.toolNames,
      hasVision: features.hasVision,
      requiresStructuredOutput: features.requiresStructuredOutput,
      unavailableModels: unavailable,
      restrictToCatalog: true,
    });
    const raw = d.candidates ?? (d.tierConfigs ? getFallbackChain(d.tier, d.tierConfigs) : [d.model]);
    // Defence in depth: the engine is told restrictToCatalog, but never dispatch an id we do not own.
    const chain = [...new Set(raw)].filter((m) => this.ids.has(m));
    return {
      features,
      decision: {
        mode: "profile",
        profile: target.profile,
        chain,
        tier: d.tier,
        taskType: d.taskType,
        confidence: d.confidence,
        agentRisk: d.agentRisk,
        reasoning: d.reasoning,
        strategy: this.opts.strategy,
        excluded: [...unavailable],
      },
    };
  }
}
