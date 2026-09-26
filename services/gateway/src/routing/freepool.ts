/**
 * Where chat models come from. In production: OpenRouter's free models,
 * synced from the public model list every few hours (no key needed). A
 * failed sync keeps the last good list, and until the first success chat
 * has no capacity. In catalog mode (tests, local runs): the static catalog.
 */
import type { Catalog, Deployment } from "../catalog.ts";
import type { ModelDeployments } from "../pool.ts";

export type FreeModel = { id: string; contextLength: number; maxOutput: number; tools: boolean; json: boolean };
export type ModelSource = { models(): readonly FreeModel[]; ready(): boolean };

const EXCLUDED = [/content-safety/, /^stealth\//, /^openrouter\//];

type RawModel = {
  id?: unknown;
  context_length?: unknown;
  architecture?: { output_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown };
  supported_parameters?: unknown;
};

/** The free chat models in a GET /api/v1/models body, sorted by id. */
export function parseFreeModels(body: unknown): FreeModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("models list: no data array");
  const out: FreeModel[] = [];
  for (const m of data as RawModel[]) {
    const id = m?.id;
    if (typeof id !== "string" || !id.endsWith(":free") || EXCLUDED.some((re) => re.test(id))) continue;
    const outputs = m.architecture?.output_modalities;
    if (!Array.isArray(outputs) || !outputs.includes("text")) continue;
    const contextLength = m.context_length;
    if (typeof contextLength !== "number" || !Number.isInteger(contextLength) || contextLength <= 0) continue;
    const maxOut = m.top_provider?.max_completion_tokens;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    out.push({
      id,
      contextLength,
      maxOutput: typeof maxOut === "number" && Number.isInteger(maxOut) && maxOut > 0 ? maxOut : contextLength,
      tools: params.includes("tools"),
      json: params.includes("response_format") || params.includes("structured_outputs"),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type FreePoolOptions = { baseUrl: string; intervalMs: number; timeoutMs: number; onChange: (models: FreeModel[]) => void };

export class FreePool implements ModelSource {
  private list: FreeModel[] = [];
  private synced = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly opts: FreePoolOptions;

  constructor(opts: FreePoolOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
  }

  models(): readonly FreeModel[] {
    return this.list;
  }

  ready(): boolean {
    return this.synced && this.list.length > 0;
  }

  /** Fetch the model list; true when it replaced the current one. */
  async sync(): Promise<boolean> {
    let models: FreeModel[];
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/v1/models`, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      if (!res.ok) {
        await res.body?.cancel();
        return false;
      }
      models = parseFreeModels(await res.json());
    } catch {
      return false;
    }
    if (models.length === 0) return false; // an empty list is a bad sync, not a real lineup
    this.list = models;
    this.synced = true;
    this.opts.onChange(models);
    return true;
  }

  start(): void {
    if (this.timer || this.opts.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.sync(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Pool entries for OpenRouter models: one deployment each, never probed. */
export function openRouterDeployments(models: readonly FreeModel[], baseUrl: string, apiKeyEnv: string): ModelDeployments[] {
  const root = `${baseUrl.replace(/\/+$/, "")}/api/v1`;
  return models.map((m) => {
    const deployment: Deployment = { id: `${m.id}@openrouter`, adapter: "openai", baseUrl: root, servedModel: m.id, apiKeyEnv, probe: false };
    return { id: m.id, deployments: [deployment] };
  });
}

/** Catalog mode: the static catalog's models, always ready. The catalog does not say whether a model returns JSON, so it is assumed. */
export function catalogSource(catalog: Catalog): ModelSource {
  const list: FreeModel[] = catalog.models.map((m) => ({
    id: m.id,
    contextLength: m.capabilities.contextWindow,
    maxOutput: m.capabilities.maxOutputTokens,
    tools: m.capabilities.supportsTools,
    json: true,
  }));
  return { models: () => list, ready: () => list.length > 0 };
}
