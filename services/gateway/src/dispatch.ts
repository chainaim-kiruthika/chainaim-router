/**
 * Dispatch: one attempt of one model (spec section 7). The chat pipeline
 * (chat.ts) walks the chain, applying the quota and the deny-unavailable
 * cache between attempts.
 */
import type { HealthEffect, Pool } from "./pool.ts";
import { categorize, REQUEST_FAULTS, type DataCollection, type Outcome } from "./openrouter.ts";

/** One try of one model, as the ledger records it (never an error body). */
export type ModelAttempt = { model: string; outcome: Outcome; status?: number; ms: number };
export type AttemptResult = { attempt: ModelAttempt; completion?: Record<string, unknown>; accountScope?: "minute" | "day" };

/**
 * What an outcome says about the deployment's health (spec section 7 and plan
 * refinement 4). Of the upstream errors, only a refusal caused by the request
 * leaves the model alone: 400, 413 and 422, and a 403. If it did not, a
 * caller whose payment is verified but never settled could cool every model
 * down for free. A 404 "No endpoints found", any other 4xx, a 5xx and an
 * empty or malformed 2xx answer cool the model down.
 */
function healthEffect(outcome: Outcome, status: number | undefined): HealthEffect {
  if (outcome === "ok") return "ok";
  if (outcome === "rate_limited_provider" || outcome === "model_restricted") return "cooldown"; // a gated model refuses every caller, so skip it for a while
  if (outcome === "upstream_error") {
    // categorize sends 401 and every 403 without moderation or routing metadata to key_rejected, so a 403 here is a moderation refusal: about the request, not the model.
    return status !== undefined && (REQUEST_FAULTS.has(status) || status === 403) ? "neutral" : "cooldown";
  }
  if (outcome === "timeout" || outcome === "network_error") return "fail";
  return "neutral"; // account limits, a rejected key, the data policy, a client abort: not this model's health
}

/**
 * A 2xx body counts only when it is a chat completion whose first choice
 * holds an answer: text content that is not blank, or at least one tool call.
 * A reasoning model that spends the whole token cap answers with no content,
 * and the caller must not pay for that.
 */
export function parseCompletion(text: string): Record<string, unknown> | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined; // not JSON
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined;
  const choices = (j as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown; tool_calls?: unknown } } | null | undefined) : undefined;
  const content = first?.message?.content;
  const calls = first?.message?.tool_calls;
  const answered = (typeof content === "string" && content.trim() !== "") || (Array.isArray(calls) && calls.length > 0);
  return answered ? (j as Record<string, unknown>) : undefined;
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
