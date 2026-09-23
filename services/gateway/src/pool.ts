/**
 * Deployment pool: which replica of a model takes the next request.
 *
 * - Health: periodic GET on each deployment's healthUrl; request failures
 *   count too. After `unhealthyAfter` consecutive failures a deployment is
 *   taken out for `cooldownMs`, then probed again.
 * - Choice: among healthy deployments of a model, the one with the fewest
 *   requests in flight (ties keep catalog order).
 */
import type { Catalog, Deployment } from "./catalog.ts";

export type PoolOptions = {
  healthIntervalMs: number;
  healthTimeoutMs: number;
  unhealthyAfter: number;
  cooldownMs: number;
  env: NodeJS.ProcessEnv;
};

type State = {
  deployment: Deployment;
  modelId: string;
  healthy: boolean;
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
  private readonly byModel = new Map<string, State[]>();
  private readonly opts: PoolOptions;
  private timer: NodeJS.Timeout | undefined;

  constructor(catalog: Catalog, opts: PoolOptions) {
    this.opts = opts;
    for (const m of catalog.models) {
      this.byModel.set(
        m.id,
        m.deployments.map((d) => ({ deployment: d, modelId: m.id, healthy: true, inFlight: 0, consecutiveFailures: 0, downUntil: 0 })),
      );
    }
  }

  static healthUrlOf(d: Deployment): string {
    return d.healthUrl ?? `${d.baseUrl.replace(/\/+$/, "")}/models`;
  }

  apiKeyFor(d: Deployment): string | undefined {
    return d.apiKeyEnv ? this.opts.env[d.apiKeyEnv] : undefined;
  }

  private usable(s: State, now: number): boolean {
    return s.healthy && s.downUntil <= now;
  }

  /** Models with no usable deployment right now; fed to the engine as unavailableModels. */
  unavailableModels(): string[] {
    const now = Date.now();
    return [...this.byModel.entries()].filter(([, states]) => !states.some((s) => this.usable(s, now))).map(([id]) => id);
  }

  /** Least-busy usable deployment of a model, or undefined when none is usable. */
  acquire(modelId: string): { deployment: Deployment; release: (ok: boolean, error?: string) => void } | undefined {
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
      release: (ok: boolean, error?: string) => {
        if (released) return;
        released = true;
        chosen.inFlight--;
        if (ok) this.recordSuccess(chosen);
        else this.recordFailure(chosen, error ?? "request failed");
      },
    };
  }

  private recordSuccess(s: State): void {
    s.consecutiveFailures = 0;
    s.healthy = true;
    s.downUntil = 0;
    s.lastError = undefined;
  }

  private recordFailure(s: State, error: string): void {
    s.consecutiveFailures++;
    s.lastError = error;
    if (s.consecutiveFailures >= this.opts.unhealthyAfter) {
      s.healthy = false;
      s.downUntil = Date.now() + this.opts.cooldownMs;
    }
  }

  private async probe(s: State): Promise<void> {
    const headers: Record<string, string> = {};
    const key = this.apiKeyFor(s.deployment);
    if (key) headers.authorization = `Bearer ${key}`;
    try {
      const res = await fetch(Pool.healthUrlOf(s.deployment), { headers, signal: AbortSignal.timeout(this.opts.healthTimeoutMs) });
      await res.body?.cancel();
      if (res.ok) this.recordSuccess(s);
      else this.recordFailure(s, `health HTTP ${res.status}`);
    } catch (e) {
      this.recordFailure(s, `health ${(e as Error).name}: ${(e as Error).message}`);
    } finally {
      s.lastCheckedAt = new Date().toISOString();
    }
  }

  /** One full health round over every deployment. */
  async checkAll(): Promise<void> {
    await Promise.all([...this.byModel.values()].flat().map((s) => this.probe(s)));
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
    return [...this.byModel.values()].flat().map((s) => ({
      id: s.deployment.id,
      model: s.modelId,
      healthy: this.usable(s, Date.now()),
      inFlight: s.inFlight,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
      lastCheckedAt: s.lastCheckedAt,
    }));
  }
}
