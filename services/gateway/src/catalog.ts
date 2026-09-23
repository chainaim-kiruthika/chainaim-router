/**
 * Model catalog: the single file that says which models exist, where each one
 * is served (its deployments), what it can do, and how the route engine should
 * rank it. Everything else (engine options, deployment pool, /v1/models) is
 * derived from this file.
 */
import { readFileSync } from "node:fs";

export const TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const;
export type Tier = (typeof TIERS)[number];

export const PROFILES = ["auto", "eco", "premium"] as const;
export type Profile = (typeof PROFILES)[number];

/** Where a model runs. Policy (Iteration 1) restricts routing by zone. */
export const ZONES = ["local", "private-cloud", "public-api"] as const;
export type Zone = (typeof ZONES)[number];

/** Wire protocol spoken to the deployment. Only OpenAI-compatible in Iteration 0. */
export const ADAPTERS = ["openai"] as const;
export type AdapterKind = (typeof ADAPTERS)[number];

export type Deployment = {
  /** Unique across the whole catalog, e.g. "qwen-small@cpu-a". */
  id: string;
  adapter: AdapterKind;
  /** Base URL that ends at the API root, e.g. "http://127.0.0.1:8081/v1". */
  baseUrl: string;
  /** Model name the server expects in the request body. */
  servedModel: string;
  /** Name of the environment variable holding this deployment's API key. Never the key itself. */
  apiKeyEnv?: string;
  /** Liveness URL. Defaults to `${baseUrl}/models`. */
  healthUrl?: string;
};

export type ModelEntry = {
  /** Catalog id clients and the route engine use, e.g. "local/qwen2.5-0.5b". */
  id: string;
  zone: Zone;
  capabilities: {
    contextWindow: number;
    maxOutputTokens: number;
    supportsTools: boolean;
    supportsVision: boolean;
  };
  /** USD per 1M tokens. For self-hosted models use your amortised hardware cost. */
  pricing: { inputPerM: number; outputPerM: number };
  deployments: Deployment[];
};

export type TierChains = Record<Tier, string[]>;

export type Catalog = {
  version: string;
  models: ModelEntry[];
  /** Ordered model ids per tier, per routing profile. First = primary. */
  profiles: Record<Profile, TierChains>;
  /** Optional chains used when a request carries tools. Omit to use the profile's chains. */
  agentic?: TierChains;
};

export class CatalogError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new CatalogError(msg);
}

function validateChains(chains: unknown, where: string, ids: Set<string>): asserts chains is TierChains {
  need(isObj(chains), `${where}: must be an object keyed by tier`);
  for (const tier of TIERS) {
    const list = chains[tier];
    need(Array.isArray(list) && list.length > 0, `${where}.${tier}: must be a non-empty array of model ids`);
    for (const id of list) {
      need(typeof id === "string" && ids.has(id), `${where}.${tier}: unknown model id ${JSON.stringify(id)}`);
    }
    need(new Set(list).size === list.length, `${where}.${tier}: duplicate model id`);
  }
}

/** Validate an already-parsed catalog object. Throws CatalogError with the first problem found. */
export function validateCatalog(raw: unknown): Catalog {
  need(isObj(raw), "catalog: must be a JSON object");
  need(typeof raw.version === "string" && raw.version.length > 0, "catalog.version: required string");
  need(Array.isArray(raw.models) && raw.models.length > 0, "catalog.models: non-empty array required");

  const ids = new Set<string>();
  const deploymentIds = new Set<string>();
  raw.models.forEach((m: unknown, i: number) => {
    const at = `catalog.models[${i}]`;
    need(isObj(m), `${at}: must be an object`);
    need(typeof m.id === "string" && /^[\w.-]+\/[\w.:-]+$/.test(m.id), `${at}.id: expected "<namespace>/<name>"`);
    need(!m.id.startsWith("chainaim/"), `${at}.id: the "chainaim/" namespace is reserved for routing profiles`);
    need(!ids.has(m.id), `${at}.id: duplicate ${m.id}`);
    ids.add(m.id);
    need(ZONES.includes(m.zone as Zone), `${at}.zone: one of ${ZONES.join(", ")}`);

    const c = m.capabilities;
    need(isObj(c), `${at}.capabilities: required`);
    need(Number.isInteger(c.contextWindow) && (c.contextWindow as number) > 0, `${at}.capabilities.contextWindow: positive integer`);
    need(Number.isInteger(c.maxOutputTokens) && (c.maxOutputTokens as number) > 0, `${at}.capabilities.maxOutputTokens: positive integer`);
    need(typeof c.supportsTools === "boolean", `${at}.capabilities.supportsTools: boolean`);
    need(typeof c.supportsVision === "boolean", `${at}.capabilities.supportsVision: boolean`);

    const p = m.pricing;
    need(isObj(p), `${at}.pricing: required (use your amortised cost for self-hosted models)`);
    need(typeof p.inputPerM === "number" && p.inputPerM >= 0, `${at}.pricing.inputPerM: number >= 0`);
    need(typeof p.outputPerM === "number" && p.outputPerM >= 0, `${at}.pricing.outputPerM: number >= 0`);

    need(Array.isArray(m.deployments) && m.deployments.length > 0, `${at}.deployments: at least one`);
    m.deployments.forEach((d: unknown, j: number) => {
      const dat = `${at}.deployments[${j}]`;
      need(isObj(d), `${dat}: must be an object`);
      need(typeof d.id === "string" && d.id.length > 0, `${dat}.id: required`);
      need(!deploymentIds.has(d.id), `${dat}.id: duplicate ${d.id}`);
      deploymentIds.add(d.id);
      need(ADAPTERS.includes(d.adapter as AdapterKind), `${dat}.adapter: one of ${ADAPTERS.join(", ")}`);
      need(typeof d.baseUrl === "string" && URL.canParse(d.baseUrl), `${dat}.baseUrl: valid URL`);
      need(typeof d.servedModel === "string" && d.servedModel.length > 0, `${dat}.servedModel: required`);
      if (d.apiKeyEnv !== undefined) {
        need(typeof d.apiKeyEnv === "string" && /^[A-Z_][A-Z0-9_]*$/.test(d.apiKeyEnv), `${dat}.apiKeyEnv: environment variable NAME (not the key)`);
      }
      if (d.healthUrl !== undefined) {
        need(typeof d.healthUrl === "string" && URL.canParse(d.healthUrl), `${dat}.healthUrl: valid URL`);
      }
    });
  });

  need(isObj(raw.profiles), "catalog.profiles: required");
  for (const profile of PROFILES) validateChains(raw.profiles[profile], `catalog.profiles.${profile}`, ids);
  if (raw.agentic !== undefined) validateChains(raw.agentic, "catalog.agentic", ids);

  return raw as unknown as Catalog;
}

export function loadCatalog(path: string): Catalog {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new CatalogError(`cannot read catalog ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CatalogError(`catalog ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return validateCatalog(parsed);
}
