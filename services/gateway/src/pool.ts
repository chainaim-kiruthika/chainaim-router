/**
 * Deployment pool: which replica of a model takes the next request, and
 * which models are cooling down.
 *
 * - Health: request outcomes count, and deployments with a probe also get a
 *   periodic GET on their healthUrl. After `unhealthyAfter` consecutive
 *   failures, or at once for failures that mean "back off", a deployment
 *   sits out for `cooldownMs`. When the cooldown ends it is usable again:
 *   the next request is the trial, and one more failure sends it back.
 * - OpenRouter deployments set probe: false; the cooldown is their only
 *   health signal.
 * - Choice: among usable deployments of a model, the one with the fewest
 *   requests in flight (ties keep list order).
 * - The model list can change at runtime (the free pool sync); deployments
 *   that stay keep their health.
 */
import type { Deployment } from "./catalog.ts";

export type PoolOptions = {
  healthIntervalMs: number;
  healthTimeoutMs: number;
  unhealthyAfter: number;
  cooldownMs: number;
  env: NodeJS.ProcessEnv;
};

export type ModelDeployments = { id: string; deployments: readonly Deployment[] };

/** What one request says about a deployment's health. */
export type HealthEffect = "ok" | "fail" | "cooldown" | "neutral";

type State = {
  deployment: Deployment;
  modelId: string;
  inFlight: number;
  consecutiveFailures: number;
  downUntil: number;
  lastError?: string;
  lastCheckedAt?: string;
};

export type DeploymentStatus = {
  id: string;
  model: string;
  healthy: boolean;
  inFlight: number;
  consecutiveFailures: number;
  lastError?: string;
  lastCheckedAt?: string;
};

export class Pool {
  private byModel = new Map<string, State[]>();
  private readonly opts: PoolOptions;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: PoolOptions) {
    this.opts = opts;
  }

  /** Replace the model list. A deployment that stays (same model, same id) keeps its health and in-flight count. */
  setModels(models: readonly ModelDeployments[]): void {
    const previous = new Map<string, State>();
    for (const states of this.byModel.values()) for (const s of states) previous.set(`${s.modelId}\u0000${s.deployment.id}`, s);
    this.byModel = new Map(
      models.map((m) => [
        m.id,
        m.deployments.map((d): State => {
          const kept = previous.get(`${m.id}\u0000${d.id}`);
          if (kept) {
            kept.deployment = d;
            return kept;
          }
          return { deployment: d, modelId: m.id, inFlight: 0, consecutiveFailures: 0, downUntil: 0 };
        }),
      ]),
    );
  }

  static healthUrlOf(d: Deployment): string {
    return d.healthUrl ?? `${d.baseUrl.replace(/\/+$/, "")}/models`;
  }

  apiKeyFor(d: Deployment): string | undefined {
    return d.apiKeyEnv ? this.opts.env[d.apiKeyEnv] : undefined;
  }

  private usable(s: State, now: number): boolean {
    return s.downUntil <= now;
  }

  /** Models with no usable deployment right now. */
  unavailableModels(): string[] {
    const now = Date.now();
    return [...this.byModel.entries()].filter(([, states]) => !states.some((s) => this.usable(s, now))).map(([id]) => id);
  }

  /** True when the model has no usable deployment now; an unknown model counts as unusable. */
  isCoolingDown(modelId: string): boolean {
    const states = this.byModel.get(modelId);
    const now = Date.now();
    return !states || !states.some((s) => this.usable(s, now));
  }

  /** Least-busy usable deployment of a model, or undefined when none is usable. */
  acquire(modelId: string): { deployment: Deployment; release: (effect: HealthEffect, error?: string) => void } | undefined {
    const states = this.byModel.get(modelId);
    if (!states) return undefined;
    const now = Date.now();
    let best: State | undefined;
    for (const s of states) {
      if (!this.usable(s, now)) continue;
      if (!best || s.inFlight < best.inFlight) best = s;
    }
    if (!best) return undefined;
    const chosen = best;
    chosen.inFlight++;
    let released = false;
    return {
      deployment: chosen.deployment,
      release: (effect: HealthEffect, error?: string) => {
        if (released) return;
        released = true;
        chosen.inFlight--;
        if (effect === "ok") this.recordSuccess(chosen);
        else if (effect === "fail") this.recordFailure(chosen, error ?? "request failed");
        else if (effect === "cooldown") this.coolDown(chosen, error ?? "cooling down");
      },
    };
  }

  private recordSuccess(s: State): void {
    s.consecutiveFailures = 0;
    s.downUntil = 0;
    s.lastError = undefined;
  }

  private recordFailure(s: State, error: string): void {
    s.consecutiveFailures++;
    s.lastError = error;
    if (s.consecutiveFailures >= this.opts.unhealthyAfter) s.downUntil = Date.now() + this.opts.cooldownMs;
  }

  /** Out at once; after the cooldown, one more failure sends it straight back. */
  private coolDown(s: State, error: string): void {
    s.consecutiveFailures = Math.max(s.consecutiveFailures + 1, this.opts.unhealthyAfter);
    s.lastError = error;
    s.downUntil = Date.now() + this.opts.cooldownMs;
  }

  private async probe(s: State): Promise<void> {
    const headers: Record<string, string> = {};
    const key = this.apiKeyFor(s.deployment);
    if (key) headers.authorization = `Bearer ${key}`;
    try {
      const res = await fetch(Pool.healthUrlOf(s.deployment), { headers, signal: AbortSignal.timeout(this.opts.healthTimeoutMs) });
      await res.body?.cancel().catch(() => undefined); // cancel() rejects when the stream already failed
      if (res.ok) this.recordSuccess(s);
      else this.recordFailure(s, `health HTTP ${res.status}`);
    } catch (e) {
      this.recordFailure(s, `health ${(e as Error).name}: ${(e as Error).message}`);
    } finally {
      s.lastCheckedAt = new Date().toISOString();
    }
  }

  /** One health round over every deployment that has a probe. */
  async checkAll(): Promise<void> {
    const probed = [...this.byModel.values()].flat().filter((s) => s.deployment.probe !== false);
    await Promise.all(probed.map((s) => this.probe(s)));
  }

  start(): void {
    if (this.opts.healthIntervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.checkAll(), this.opts.healthIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): DeploymentStatus[] {
    const now = Date.now();
    return [...this.byModel.values()].flat().map((s) => ({
      id: s.deployment.id,
      model: s.modelId,
      healthy: this.usable(s, now),
      inFlight: s.inFlight,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
      lastCheckedAt: s.lastCheckedAt,
    }));
  }
}
