/**
 * OpenRouter requests and failures (spec section 7). shapeBody decides what
 * leaves the gateway; categorize sorts an upstream answer into an outcome.
 * Upstream bodies are read here and never stored.
 */
export type DataCollection = "allow" | "deny";
export type Outcome =
  | "ok"
  | "rate_limited_account"
  | "rate_limited_provider"
  | "data_policy_unavailable"
  | "key_rejected"
  | "model_restricted"
  | "upstream_error"
  | "timeout"
  | "network_error"
  | "client_abort"
  | "no_deployment";

/**
 * Request fields a client may set that reach the model. Everything else,
 * including provider, models, route, transforms, plugins, user and metadata,
 * is dropped: a client can't override the data policy, pass an identifier,
 * or slip unscanned text (such as `prediction`) past the scanner.
 */
export const PASSTHROUGH = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed",
  "stop",
] as const;

/** The upstream body before the per-attempt model, stream and provider fields. */
export function shapeBody(request: Readonly<Record<string, unknown>>, messages: readonly unknown[], maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = { messages, max_tokens: maxTokens };
  for (const field of PASSTHROUGH) if (request[field] !== undefined) body[field] = request[field];
  return body;
}

/** Upstream statuses that mean the request itself was refused; the caller gets them back. */
export const REQUEST_FAULTS: ReadonlySet<number> = new Set([400, 413, 422]);

export type Categorized = { outcome: Outcome; accountScope?: "minute" | "day" };

function errorOf(text: string): { message: string; providerName: string | undefined; moderation: boolean; routed: boolean } {
  try {
    const e = (JSON.parse(text) as { error?: { message?: unknown; metadata?: Record<string, unknown> } } | null)?.error;
    const meta = e?.metadata ?? {};
    return {
      message: typeof e?.message === "string" ? e.message : "",
      providerName: typeof meta.provider_name === "string" ? meta.provider_name : undefined,
      moderation: "reasons" in meta || "flagged_input" in meta,
      routed: "routing_funnel" in meta,
    };
  } catch {
    return { message: "", providerName: undefined, moderation: false, routed: false };
  }
}

export function categorize(status: number, text: string, dataCollection: DataCollection): Categorized {
  if (status >= 200 && status < 300) return { outcome: "ok" };
  const { message, providerName, moderation, routed } = errorOf(text);
  // A 403 that carries routing metadata came after OpenRouter accepted the key and started routing, so it is about this
  // model (for example "only available on agentic harnesses"), not the key. Any other 403 is still a rejected key.
  if (status === 403 && !moderation && routed) return { outcome: "model_restricted" };
  if (status === 401 || (status === 403 && !moderation)) return { outcome: "key_rejected" };
  if (status === 429) {
    if (/free-models-per-day/i.test(message)) return { outcome: "rate_limited_account", accountScope: "day" };
    // A 429 without a provider name is OpenRouter's own limit on this key.
    if (/free-models-per-min/i.test(message) || providerName === undefined) return { outcome: "rate_limited_account", accountScope: "minute" };
    return { outcome: "rate_limited_provider" };
  }
  if ((status === 404 || status === 503) && dataCollection === "deny" && /data policy|data_collection|routing requirements/i.test(message)) {
    return { outcome: "data_policy_unavailable" };
  }
  return { outcome: "upstream_error" };
}
