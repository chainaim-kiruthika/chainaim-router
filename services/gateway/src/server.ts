/**
 * ChainAim gateway HTTP surface (spec section 8). It is private: only the
 * paywall reaches it, with the gateway key.
 *
 *   POST /v1/privacy/scan       entities and data class; no model is called
 *   POST /v1/privacy/mask       masked text and the placeholder map
 *   POST /v1/chat/completions   private chat: mask, route, call, restore
 *   POST /v1/route/explain      the chat decision without a chat-model call (calls Jev)
 *   GET  /v1/models             chainaim/auto and the current free pool
 *   GET  /internal/capacity     whether chat can be served now (the paywall's guard)
 *   GET  /v1/deployments        per-deployment health
 *   GET  /healthz               200 when Presidio answered its last check (no auth)
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { explainChat, runChat, toSse, type ChatDeps } from "./chat.ts";
import { HttpError } from "./errors.ts";
import type { Ledger } from "./ledger.ts";
import { classify, countTypes } from "./privacy/classify.ts";
import type { Detected } from "./privacy/entities.ts";
import { Masker } from "./privacy/mask.ts";
import { PresidioError } from "./privacy/presidio.ts";

/** Scan and mask accept a text of 1 to this many characters. */
export const MAX_TEXT_CHARS = 20_000;

export type GatewayDeps = ChatDeps & { ledger: Ledger };
export type ServerOptions = {
  maxBodyBytes: number;
  /** Bearer token clients must send; undefined = no gateway auth (bind to localhost only). */
  gatewayKey: string | undefined;
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { message, type: status >= 500 ? "gateway_error" : "invalid_request_error", code: status } }, headers);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function authorized(req: IncomingMessage, key: string | undefined): boolean {
  if (!key) return true;
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createGateway(deps: GatewayDeps, opts: ServerOptions): Server {
  const { presidio, ledger } = deps;

  /** scan and mask (spec section 4): detect, classify, and for mask replace. */
  async function privacy(kind: "scan" | "mask", req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const decisionId = randomUUID();
    const body = await readJson(req, opts.maxBodyBytes);
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_CHARS) {
      throw new HttpError(400, `text: a string of 1 to ${MAX_TEXT_CHARS} characters is required`);
    }
    const headers = { "x-chainaim-decision-id": decisionId };
    const entry = { ts: new Date().toISOString(), decisionId, endpoint: kind, textChars: text.length };
    const latencyMs = () => Math.round(performance.now() - started);

    let entities: Detected[];
    try {
      entities = await presidio.analyze(text);
    } catch (e) {
      if (!(e instanceof PresidioError)) throw e;
      ledger.write({ ...entry, status: 503, latencyMs: latencyMs() });
      sendError(res, 503, "the privacy scanner is unavailable; try again shortly", headers);
      return;
    }
    const classes = classify(entities.map((e) => e.type));
    const counts = countTypes(entities);
    const found = { dataClass: classes.dataClass, found: classes.found, entityCounts: counts };

    if (kind === "scan") {
      sendJson(res, 200, { decisionId, dataClass: classes.dataClass, found: classes.found, entities, counts, policy: classes.policy }, headers);
      ledger.write({ ...entry, ...found, cardsRemoved: 0, status: 200, latencyMs: latencyMs() });
      return;
    }
    const masker = new Masker();
    const maskedText = masker.mask(text, entities);
    sendJson(
      res,
      200,
      { decisionId, dataClass: classes.dataClass, found: classes.found, maskedText, map: masker.map, counts, cardsRemoved: masker.cardsRemoved },
      headers,
    );
    ledger.write({ ...entry, ...found, cardsRemoved: masker.cardsRemoved, status: 200, latencyMs: latencyMs() });
  }

  /** Private chat (spec section 4); the headers are spec 8.2's. */
  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const decisionId = randomUUID();
    const body = await readJson(req, opts.maxBodyBytes);
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const result = await runChat(body, deps, abort.signal);
    const status = result.ok ? 200 : result.status;
    ledger.write({ ts: new Date().toISOString(), decisionId, endpoint: "chat", ...result.record, status, latencyMs: Math.round(performance.now() - started) });

    const headers: Record<string, string> = { "x-chainaim-decision-id": decisionId, "x-chainaim-attempts": String(result.record.attempts.length) };
    if (!result.ok) {
      if (result.status === 499) return; // the client is gone
      if (result.retryAfterSec !== undefined) headers["retry-after"] = String(result.retryAfterSec);
      sendError(res, result.status, result.message, headers);
      return;
    }
    headers["x-chainaim-data-class"] = result.record.dataClass ?? "none";
    headers["x-chainaim-classifier"] = result.record.classifier ?? "rules";
    headers["x-chainaim-model"] = result.record.served ?? "";
    if (!result.stream) {
      sendJson(res, 200, result.completion, headers);
      return;
    }
    const text = toSse(result.completion);
    res.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  async function explain(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const decisionId = randomUUID();
    const { attempts: _attempts, ...decision } = await explainChat(await readJson(req, opts.maxBodyBytes), deps);
    sendJson(res, 200, { decisionId, decision }, { "x-chainaim-decision-id": decisionId });
  }

  const models = () => ({
    object: "list",
    data: [
      { id: "chainaim/auto", object: "model", owned_by: "chainaim" },
      ...deps.source.models().map((m) => ({ id: m.id, object: "model", owned_by: m.id.split("/")[0], context_length: m.contextLength, supports_tools: m.tools })),
    ],
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /healthz") {
        // Unauthenticated: says only whether Presidio answered its last check.
        sendJson(res, presidio.healthy ? 200 : 503, { status: presidio.healthy ? "ok" : "privacy_scanner_unavailable" });
        return;
      }
      if (!authorized(req, opts.gatewayKey)) {
        sendError(res, 401, "missing or invalid gateway API key");
        return;
      }
      if (route === "POST /v1/privacy/scan") await privacy("scan", req, res);
      else if (route === "POST /v1/privacy/mask") await privacy("mask", req, res);
      else if (route === "POST /v1/chat/completions") await chat(req, res);
      else if (route === "POST /v1/route/explain") await explain(req, res);
      else if (route === "GET /v1/models") sendJson(res, 200, models());
      else if (route === "GET /internal/capacity") sendJson(res, 200, deps.quota.capacity(deps.source.ready()));
      else if (route === "GET /v1/deployments") sendJson(res, 200, { unavailableModels: deps.pool.unavailableModels(), deployments: deps.pool.status() });
      else sendError(res, 404, `no route for ${route}`);
    } catch (e) {
      if (e instanceof HttpError) sendError(res, e.status, e.message, e.headers);
      else {
        console.error(`[chainaim-gateway] ${route}:`, e);
        sendError(res, 500, "internal gateway error");
      }
    }
  });
}
