/**
 * Dispatch: send the request to one deployment, and walk the decision chain
 * until one answers. Fallback happens only before the response starts; once
 * headers arrive the answer (streamed or not) belongs to that deployment.
 */
import type { Deployment } from "./catalog.ts";
import type { ChatRequest } from "./engine.ts";
import type { HealthEffect, Pool } from "./pool.ts";
import { categorize, type DataCollection, type Outcome } from "./openrouter.ts";

export type Attempt = {
  model: string;
  deployment?: string;
  status?: number;
  ms: number;
  outcome: "ok" | "http_error" | "timeout" | "network_error" | "no_deployment" | "client_abort";
  error?: string;
};

export type DispatchOptions = { maxAttempts: number; attemptTimeoutMs: number };

export type DispatchResult =
  | { ok: true; response: Response; model: string; deployment: Deployment; attempts: Attempt[]; done: (effect: HealthEffect, error?: string) => void }
  | { ok: false; attempts: Attempt[]; status: number; message: string };

/** Build the upstream request for an OpenAI-compatible deployment. */
function openAiRequest(d: Deployment, body: ChatRequest, apiKey: string | undefined, signal: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const url = `${d.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, model: d.servedModel }), signal });
}

export async function dispatch(
  chain: readonly string[],
  body: ChatRequest,
  pool: Pool,
  opts: DispatchOptions,
  clientSignal: AbortSignal,
): Promise<DispatchResult> {
  const attempts: Attempt[] = [];
  let lastStatus = 503;
  let lastMessage = "no model in the decision chain has a healthy deployment";

  for (const model of chain) {
    if (attempts.filter((a) => a.outcome !== "no_deployment").length >= opts.maxAttempts) break;
    const lease = pool.acquire(model);
    if (!lease) {
      attempts.push({ model, ms: 0, outcome: "no_deployment" });
      continue;
    }
    const { deployment, release } = lease;
    const started = performance.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`no response headers within ${opts.attemptTimeoutMs} ms`)), opts.attemptTimeoutMs);
    const signal = AbortSignal.any([clientSignal, timeout.signal]);
    try {
      const response = await openAiRequest(deployment, body, pool.apiKeyFor(deployment), signal);
      clearTimeout(timer);
      const ms = Math.round(performance.now() - started);
      if (response.ok) {
        attempts.push({ model, deployment: deployment.id, status: response.status, ms, outcome: "ok" });
        return { ok: true, response, model, deployment, attempts, done: release };
      }
      const text = (await response.text()).slice(0, 500);
      attempts.push({ model, deployment: deployment.id, status: response.status, ms, outcome: "http_error", error: text });
      // 4xx other than 408/429 is about the request, not the deployment's health.
      const deploymentFault = response.status >= 500 || response.status === 408 || response.status === 429;
      release(deploymentFault ? "fail" : "ok", `HTTP ${response.status}`);
      lastStatus = response.status;
      lastMessage = `upstream ${deployment.id} returned HTTP ${response.status}`;
    } catch (e) {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - started);
      if (clientSignal.aborted) {
        release("neutral");
        attempts.push({ model, deployment: deployment.id, ms, outcome: "client_abort" });
        return { ok: false, attempts, status: 499, message: "client closed the request" };
      }
      const timedOut = timeout.signal.aborted;
      const error = timedOut ? String(timeout.signal.reason?.message ?? "timeout") : `${(e as Error).name}: ${(e as Error).message}`;
      attempts.push({ model, deployment: deployment.id, ms, outcome: timedOut ? "timeout" : "network_error", error });
      release("fail", error);
      lastStatus = timedOut ? 504 : 502;
      lastMessage = `upstream ${deployment.id}: ${error}`;
    }
  }
  return { ok: false, attempts, status: lastStatus, message: lastMessage };
}

/** One try of one model, as the ledger records it (never an error body). */
export type ModelAttempt = { model: string; outcome: Outcome; status?: number; ms: number };
export type AttemptResult = { attempt: ModelAttempt; completion?: Record<string, unknown>; accountScope?: "minute" | "day" };

/** What an outcome says about the deployment's health (spec section 7 and plan refinement 4). */
function healthEffect(outcome: Outcome, status: number | undefined): HealthEffect {
  if (outcome === "ok") return "ok";
  if (outcome === "rate_limited_provider") return "cooldown";
  if (outcome === "upstream_error") return status === undefined || status >= 500 || status === 408 || (status >= 200 && status < 300) ? "cooldown" : "neutral";
  if (outcome === "timeout" || outcome === "network_error") return "fail";
  return "neutral"; // account limits, a rejected key, the data policy, a client abort: not this model's health
}

/** A 2xx body counts only when it is a chat completion with at least one choice. */
function parseCompletion(text: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(text) as unknown;
    const choices = (j as { choices?: unknown } | null)?.choices;
    if (typeof j === "object" && j !== null && !Array.isArray(j) && Array.isArray(choices) && choices.length > 0) return j as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * One attempt: send the masked body to one model's deployment with the data
 * policy, wait for the whole answer (upstream calls are never streamed), and
 * sort the result into an outcome. Health is updated here; the quota and the
 * deny-unavailable cache belong to the caller.
 */
export async function attemptChat(
  model: string,
  body: Record<string, unknown>,
  dataCollection: DataCollection,
  pool: Pool,
  timeoutMs: number,
  clientSignal: AbortSignal,
): Promise<AttemptResult> {
  const lease = pool.acquire(model);
  if (!lease) return { attempt: { model, outcome: "no_deployment", ms: 0 } };
  const { deployment, release } = lease;
  const started = performance.now();
  const finish = (outcome: Outcome, status?: number, extra: Partial<AttemptResult> = {}): AttemptResult => {
    release(healthEffect(outcome, status), status === undefined ? outcome : `${outcome} (HTTP ${status})`);
    const attempt: ModelAttempt = { model, outcome, ...(status === undefined ? {} : { status }), ms: Math.round(performance.now() - started) };
    return { attempt, ...extra };
  };

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const key = pool.apiKeyFor(deployment);
  if (key) headers.authorization = `Bearer ${key}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${deployment.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: deployment.servedModel, stream: false, provider: { data_collection: dataCollection } }),
      signal: AbortSignal.any([clientSignal, timeout]),
    });
    status = res.status;
    text = await res.text();
  } catch {
    if (clientSignal.aborted) return finish("client_abort");
    return finish(timeout.aborted ? "timeout" : "network_error");
  }

  const { outcome, accountScope } = categorize(status, text, dataCollection);
  if (outcome !== "ok") return finish(outcome, status, accountScope ? { accountScope } : {});
  const completion = parseCompletion(text);
  if (!completion) return finish("upstream_error", status);
  return finish("ok", status, { completion });
}
