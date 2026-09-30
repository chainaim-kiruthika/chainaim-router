/**
 * Private chat (spec section 4): validate, detect, classify, mask, classify
 * the task, select free models, call them, restore. Unscanned text never
 * leaves: messages are rebuilt field by field, and only the fields in
 * PASSTHROUGH are copied from the request.
 */
import { attemptChat, type ModelAttempt } from "./dispatch.ts";
import { HttpError } from "./errors.ts";
import { REQUEST_FAULTS, shapeBody } from "./openrouter.ts";
import type { Pool } from "./pool.ts";
import { classify, clientPlaceholderTypes, countTypes, type Classes, type DataClass, type FoundClass } from "./privacy/classify.ts";
import { Masker, mapConversation, withinValue, type Message } from "./privacy/mask.ts";
import { PresidioError, type PresidioClient } from "./privacy/presidio.ts";
import { restoreCompletion } from "./privacy/restore.ts";
import { classifyTask, type TaskClass, type TaskInput } from "./routing/classify.ts";
import type { ModelSource } from "./routing/freepool.ts";
import type { JevClient } from "./routing/jev.ts";
import type { Quota } from "./routing/quota.ts";
import type { ScoreTable, Task } from "./routing/scores.ts";
import { failedFilter, rank, type ExpiringSet, type Need } from "./routing/select.ts";

/** At most this many characters of message text (spec section 4). */
export const MAX_CHAT_CHARS = 48_000;
/** At most this many text fields (contents, parts, argument keys and values): each one is a Presidio call. */
export const MAX_CHAT_SEGMENTS = 512;
/** The chain is the top three by score (spec section 6). */
const CHAIN_LENGTH = 3;
const NO_DENY_PROVIDER = "health data only goes to model providers that do not collect data, and none is available right now; you were not charged";
const CLIENT_CLOSED = { status: 499, message: "client closed the request" };

export type ChatOptions = { maxOutputTokens: number; maxAttempts: number; attemptTimeoutMs: number; healthFlagThreshold: number };
export type ChatDeps = {
  presidio: PresidioClient;
  pool: Pool;
  source: ModelSource;
  table: ScoreTable;
  quota: Quota;
  deny: ExpiringSet;
  jev: JevClient | undefined;
  chat: ChatOptions;
};

/** What the ledger records about a chat request (spec 8.4): never text, placeholders or the map. */
export type ChatRecord = {
  promptChars: number;
  attempts: ModelAttempt[];
  dataClass?: DataClass;
  found?: FoundClass[];
  entityCounts?: Record<string, number>;
  cardsRemoved?: number;
  classifier?: "jev" | "rules";
  task?: Task;
  difficulty?: number;
  jev?: TaskClass["jev"];
  dataCollection?: "allow" | "deny";
  chain?: string[];
  served?: string;
  unresolvedPlaceholders?: number;
};

export type ChatResult =
  | { ok: true; completion: Record<string, unknown>; stream: boolean; record: ChatRecord }
  | { ok: false; status: number; message: string; retryAfterSec?: number; record: ChatRecord };

export type Validated = {
  messages: Message[];
  raw: Record<string, unknown>;
  model: string | undefined;
  maxTokens: number;
  stream: boolean;
  hasTools: boolean;
  wantsJson: boolean;
  chars: number;
};

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkMessage(m: unknown, i: number): Message {
  const at = `messages[${i}]`;
  if (!isObj(m)) throw new HttpError(400, `${at}: must be an object`);
  const { role, content } = m;
  if (typeof role !== "string" || !ROLES.has(role)) throw new HttpError(400, `${at}.role: one of ${[...ROLES].join(", ")}`);
  const out: Message = { role };
  if (typeof content === "string" || content === null) out.content = content;
  else if (Array.isArray(content)) {
    out.content = content.map((p, j) => {
      if (!isObj(p) || p.type !== "text") throw new HttpError(400, `${at}.content[${j}]: only text parts are accepted; images and other media are refused`);
      if (typeof p.text !== "string") throw new HttpError(400, `${at}.content[${j}].text: a string is required`);
      return { type: "text" as const, text: p.text };
    });
  } else if (content !== undefined) throw new HttpError(400, `${at}.content: a string, an array of text parts, or null`);
  if (m.tool_calls !== undefined) {
    if (!Array.isArray(m.tool_calls)) throw new HttpError(400, `${at}.tool_calls: an array is required`);
    out.tool_calls = m.tool_calls.map((c, j) => {
      const fn = isObj(c) ? c.function : undefined;
      if (!isObj(fn) || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
        throw new HttpError(400, `${at}.tool_calls[${j}].function: name and arguments strings are required`);
      }
      const id = isObj(c) && typeof c.id === "string" ? { id: c.id } : {};
      return { ...id, type: "function" as const, function: { name: fn.name, arguments: fn.arguments } };
    });
  }
  if (typeof m.tool_call_id === "string") out.tool_call_id = m.tool_call_id;
  return out;
}

/** Spec section 4, chat step 1. Throws HttpError(400); nothing has been scanned or logged yet. */
export function validateChat(body: unknown, maxOutputTokens: number): Validated {
  if (!isObj(body)) throw new HttpError(400, "request body must be a JSON object");
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new HttpError(400, "messages: a non-empty array is required");
  const messages = body.messages.map(checkMessage);
  let chars = 0;
  let segments = 0;
  mapConversation(messages, (text) => {
    chars += text.length;
    segments++;
    return text;
  });
  if (chars > MAX_CHAT_CHARS) throw new HttpError(400, `messages hold ${chars} characters of text; the limit is ${MAX_CHAT_CHARS}`);
  if (segments > MAX_CHAT_SEGMENTS) throw new HttpError(400, `messages hold ${segments} text fields; the limit is ${MAX_CHAT_SEGMENTS}`);
  const requested = body.max_completion_tokens ?? body.max_tokens;
  if (requested !== undefined && requested !== null && (!Number.isInteger(requested) || (requested as number) < 1)) {
    throw new HttpError(400, "max_tokens must be a positive integer");
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const format = isObj(body.response_format) ? body.response_format.type : undefined;
  return {
    messages,
    raw: body,
    model: typeof body.model === "string" ? body.model : undefined,
    maxTokens: Math.min(typeof requested === "number" ? requested : maxOutputTokens, maxOutputTokens),
    stream: body.stream === true,
    hasTools: tools.length > 0 && body.tool_choice !== "none",
    wantsJson: format === "json_object" || format === "json_schema",
    chars,
  };
}

/** The text Jev and the rules read for one message: its content, then its tool calls. */
export function messageText(m: Message): string {
  const parts: string[] = [];
  if (typeof m.content === "string") parts.push(m.content);
  else if (Array.isArray(m.content)) for (const p of m.content) parts.push(p.text);
  for (const c of m.tool_calls ?? []) parts.push(`${c.function.name}(${c.function.arguments})`);
  return parts.join("\n");
}

function taskInput(masked: readonly Message[], v: Validated): TaskInput {
  const isSystem = (m: Message) => m.role === "system" || m.role === "developer";
  const turns = masked.filter((m) => !isSystem(m)).map((m) => ({ role: m.role, text: messageText(m) }));
  const toolChars = Array.isArray(v.raw.tools) ? JSON.stringify(v.raw.tools).length : 0;
  const chars = masked.reduce((n, m) => n + messageText(m).length, 0) + toolChars;
  return {
    system: masked.filter(isSystem).map(messageText).join("\n"),
    turns,
    lastUser: turns.filter((t) => t.role === "user").at(-1)?.text ?? "",
    hasTools: v.hasTools,
    toolChoice: v.raw.tool_choice,
    promptTokens: Math.ceil(chars / 4), // the route engine's convention: characters / 4
  };
}

type Prepared = { v: Validated; masked: Message[]; masker: Masker; types: string[]; local: Classes; input: TaskInput };

/** Steps 2 to 4: detect over every text field, classify locally, mask with one shared numbering. Detection stops when `signal` aborts. */
async function prepare(v: Validated, deps: ChatDeps, record: ChatRecord, signal?: AbortSignal): Promise<Prepared> {
  const segments: { text: string; context: string }[] = [];
  mapConversation(v.messages, (text, context) => {
    segments.push({ text, context });
    return text;
  });
  const found = await deps.presidio.analyzeAll(segments.map((s) => s.context + s.text), signal);
  const entities = found.map((f, i) => withinValue(segments[i].text, f, segments[i].context.length));
  const all = entities.flat();
  // Values a client masked before sending (<C_TYPE_n>, [CARD REMOVED]) count as what they replaced, so client masking never loosens the data policy.
  const types = [...all.map((e) => e.type), ...clientPlaceholderTypes(segments.map((s) => s.text))];
  const local = classify(types);
  const masker = new Masker();
  let next = 0;
  const masked = mapConversation(v.messages, (text) => masker.mask(text, entities[next++]));
  Object.assign(record, { dataClass: local.dataClass, found: local.found, entityCounts: countTypes(all), cardsRemoved: masker.cardsRemoved });
  return { v, masked, masker, types, local, input: taskInput(masked, v) };
}

type Decision = { classes: Classes; chain: string[] };

/** Steps 5 and 6: classify the task (Jev never sees PHI), apply Jev's health flag, choose the chain. */
async function decide(p: Prepared, deps: ChatDeps, record: ChatRecord): Promise<Decision> {
  if (!deps.source.ready()) throw new HttpError(503, "no chat models are available right now; you were not charged");
  const localPhi = p.local.dataClass === "PHI";
  const task = await classifyTask(p.input, deps.jev, localPhi);
  const flagged = !localPhi && task.health !== null && task.health >= deps.chat.healthFlagThreshold;
  const classes = flagged ? classify(p.types, true) : p.local;
  const phi = classes.dataClass === "PHI";
  Object.assign(record, {
    dataClass: classes.dataClass,
    found: classes.found,
    classifier: task.classifier,
    task: task.task,
    difficulty: task.difficulty,
    jev: task.jev,
    dataCollection: classes.policy.dataCollection,
  });

  const need: Need = { task: task.task, difficulty: task.difficulty, phi, hasTools: p.v.hasTools, wantsJson: p.v.wantsJson, promptTokens: p.input.promptTokens, maxTokens: p.v.maxTokens };
  const excluders = { coolingDown: (id: string) => deps.pool.isCoolingDown(id), denyUnavailable: (id: string) => deps.deny.has(id) };
  const models = deps.source.models();
  const pinned = p.v.model === undefined ? undefined : models.find((m) => m.id === p.v.model);
  let chain: string[];
  if (pinned) {
    // A model named by the client is tried alone; any other name, chainaim/auto included, is ignored.
    const why = failedFilter(pinned, need, excluders);
    if (why === "cooling_down" || why === "data_policy") throw new HttpError(503, `model ${pinned.id} is unavailable right now (${why}); you were not charged`);
    if (why) throw new HttpError(400, `model ${pinned.id} cannot serve this request (${why})`);
    chain = [pinned.id];
  } else {
    const { ranked, excluded } = rank(models, deps.table, need, excluders);
    chain = ranked.slice(0, CHAIN_LENGTH).map((r) => r.id);
    if (chain.length === 0) {
      const policy = phi && Object.values(excluded).includes("data_policy");
      throw new HttpError(503, policy ? NO_DENY_PROVIDER : "no model can serve this request right now; you were not charged");
    }
  }
  record.chain = chain;
  return { classes, chain };
}

type ChainOutcome = { ok: true; model: string; completion: Record<string, unknown> } | { ok: false; status: number; message: string; retryAfterSec?: number };

/** Step 7 (spec section 7): every attempt counts against the quota; account limits and a rejected key stop the chain. */
async function callChain(d: Decision, p: Prepared, deps: ChatDeps, signal: AbortSignal, record: ChatRecord): Promise<ChainOutcome> {
  const body = shapeBody(p.v.raw, p.masked, p.v.maxTokens);
  const dataCollection = d.classes.policy.dataCollection;
  const attempts = record.attempts;
  for (const model of d.chain) {
    if (attempts.filter((a) => a.outcome !== "no_deployment").length >= deps.chat.maxAttempts) break;
    if (!deps.quota.take()) {
      const cap = deps.quota.capacity(true);
      return { ok: false, status: 503, message: `free-model capacity is used up right now (${cap.reason ?? "rate_limited"}); you were not charged`, retryAfterSec: cap.retryAfterSec };
    }
    const r = await attemptChat(model, body, dataCollection, deps.pool, deps.chat.attemptTimeoutMs, signal);
    attempts.push(r.attempt);
    switch (r.attempt.outcome) {
      case "ok":
        return { ok: true, model, completion: r.completion! };
      case "client_abort":
        return { ok: false, ...CLIENT_CLOSED };
      case "rate_limited_account":
        deps.quota.onAccountLimit(r.accountScope ?? "minute");
        return { ok: false, status: 503, message: "the free-model rate limit was reached; you were not charged", retryAfterSec: deps.quota.capacity(true).retryAfterSec ?? 60 };
      case "key_rejected":
        deps.quota.onKeyRejected();
        return { ok: false, status: 503, message: "the model provider rejected the gateway's key; you were not charged" };
      case "data_policy_unavailable":
        deps.deny.add(model);
        break;
      default:
        break; // a provider limit, an upstream error, a timeout, a network error or no deployment: try the next model
    }
  }
  const last = attempts.at(-1);
  if (last?.outcome === "upstream_error" && last.status !== undefined && REQUEST_FAULTS.has(last.status)) {
    return { ok: false, status: last.status, message: `the model rejected the request (HTTP ${last.status})` };
  }
  if (dataCollection === "deny" && attempts.length > 0 && attempts.every((a) => a.outcome === "data_policy_unavailable")) {
    return { ok: false, status: 503, message: NO_DENY_PROVIDER };
  }
  return { ok: false, status: 503, message: "every model tried failed; you were not charged" };
}

function refusal(e: unknown): { status: number; message: string } {
  if (e instanceof PresidioError) return { status: 503, message: "the privacy scanner is unavailable; nothing was sent to a model and you were not charged" };
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  throw e;
}

/** The whole pipeline. A 400 from validation is thrown (not logged); every later refusal comes back with its record for the ledger. */
export async function runChat(body: unknown, deps: ChatDeps, signal: AbortSignal): Promise<ChatResult> {
  const v = validateChat(body, deps.chat.maxOutputTokens);
  const record: ChatRecord = { promptChars: v.chars, attempts: [] };
  let p: Prepared;
  let d: Decision;
  try {
    p = await prepare(v, deps, record, signal);
    d = await decide(p, deps, record);
  } catch (e) {
    if (signal.aborted) return { ok: false, ...CLIENT_CLOSED, record }; // the client is gone: not a scanner or model failure
    return { ok: false, ...refusal(e), record };
  }
  const outcome = await callChain(d, p, deps, signal, record);
  if (!outcome.ok) return { ok: false, status: outcome.status, message: outcome.message, retryAfterSec: outcome.retryAfterSec, record };
  const stats = { unresolved: 0 };
  restoreCompletion(outcome.completion, p.masker.map, stats);
  record.served = outcome.model;
  record.unresolvedPlaceholders = stats.unresolved;
  return { ok: true, completion: outcome.completion, stream: v.stream, record };
}

/** The decision for a chat request without calling a chat model (Jev is called). It holds no text. */
export async function explainChat(body: unknown, deps: ChatDeps): Promise<ChatRecord> {
  const v = validateChat(body, deps.chat.maxOutputTokens);
  const record: ChatRecord = { promptChars: v.chars, attempts: [] };
  try {
    await decide(await prepare(v, deps, record), deps, record);
  } catch (e) {
    const r = refusal(e);
    throw new HttpError(r.status, r.message);
  }
  return record;
}

/** Streaming is emulated (spec section 4): one chunk with the whole restored answer, then [DONE]. */
export function toSse(completion: Record<string, unknown>): string {
  const choices = Array.isArray(completion.choices) ? (completion.choices as Record<string, unknown>[]) : [];
  const chunk = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: choices.map((c, i) => {
      const message = isObj(c.message) ? c.message : {};
      const delta: Record<string, unknown> = { role: "assistant" };
      for (const field of ["content", "reasoning", "refusal"]) if (typeof message[field] === "string") delta[field] = message[field];
      if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls.map((t, j) => ({ index: j, ...(isObj(t) ? t : {}) }));
      return { index: typeof c.index === "number" ? c.index : i, delta, finish_reason: c.finish_reason ?? null };
    }),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
