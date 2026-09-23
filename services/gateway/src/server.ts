/**
 * ChainAim gateway HTTP surface (OpenAI-compatible).
 *
 *   POST /v1/chat/completions   route + dispatch (stream or not)
 *   POST /v1/route/explain      decision only, nothing is sent to a model
 *   GET  /v1/models             catalog models + chainaim/* routing profiles
 *   GET  /v1/deployments        per-deployment health (authenticated)
 *   GET  /healthz               liveness only, no details (unauthenticated)
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { PROFILES } from "./catalog.ts";
import { dispatch, type DispatchOptions } from "./dispatch.ts";
import { Engine, PROFILE_PREFIX, RequestError, type ChatRequest } from "./engine.ts";
import type { Ledger } from "./ledger.ts";
import type { Pool } from "./pool.ts";

export type ServerOptions = DispatchOptions & {
  maxBodyBytes: number;
  /** Bearer token clients must send; undefined = no gateway auth (bind to localhost only). */
  gatewayKey: string | undefined;
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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

export function createGateway(engine: Engine, pool: Pool, ledger: Ledger, opts: ServerOptions): Server {
  const models = () => [
    ...PROFILES.map((p) => ({ id: `${PROFILE_PREFIX}${p}`, object: "model", owned_by: "chainaim", kind: "routing-profile" })),
    ...engine.catalog.models.map((m) => ({ id: m.id, object: "model", owned_by: m.zone, kind: "model", deployments: m.deployments.length })),
  ];

  async function chat(req: IncomingMessage, res: ServerResponse, explainOnly: boolean): Promise<void> {
    const started = performance.now();
    const decisionId = randomUUID();
    const body = (await readJson(req, opts.maxBodyBytes)) as ChatRequest;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "request body must be a JSON object");

    const { decision, features } = engine.decide(body, pool.unavailableModels());
    const base = { "x-chainaim-decision-id": decisionId };
    if (explainOnly) {
      sendJson(res, 200, { decisionId, decision, request: { ...features, prompt: undefined, systemPrompt: undefined } }, base);
      return;
    }

    const clientAbort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) clientAbort.abort();
    });
    const result = await dispatch(decision.chain, body, pool, opts, clientAbort.signal);
    const entryBase = {
      ts: new Date().toISOString(),
      decisionId,
      requestedModel: body.model,
      decision,
      request: {
        maxOutputTokens: features.maxOutputTokens,
        hasTools: features.hasTools,
        requiresTools: features.requiresTools,
        hasVision: features.hasVision,
        requiresStructuredOutput: features.requiresStructuredOutput,
        promptChars: features.promptChars,
        stream: body.stream === true,
      },
    };

    if (!result.ok) {
      ledger.write({ ...entryBase, attempts: result.attempts, status: result.status, latencyMs: Math.round(performance.now() - started) });
      if (result.status !== 499) sendError(res, result.status, result.message, { ...base, "x-chainaim-attempts": String(result.attempts.length) });
      return;
    }

    const upstream = result.response;
    const headers: Record<string, string> = {
      ...base,
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-chainaim-model": result.model,
      "x-chainaim-deployment": result.deployment.id,
      "x-chainaim-attempts": String(result.attempts.length),
    };
    if (decision.tier) headers["x-chainaim-tier"] = decision.tier;
    if (decision.profile) headers["x-chainaim-profile"] = decision.profile;
    res.writeHead(upstream.status, headers);

    let ok = true;
    let error: string | undefined;
    try {
      if (upstream.body) {
        const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
        for await (const chunk of stream) {
          if (clientAbort.signal.aborted) break;
          res.write(chunk);
        }
      }
      res.end();
    } catch (e) {
      ok = false;
      error = `stream: ${(e as Error).message}`;
      res.destroy();
    } finally {
      result.done(ok, error);
      ledger.write({
        ...entryBase,
        served: { model: result.model, deployment: result.deployment.id },
        attempts: result.attempts,
        status: ok ? upstream.status : 502,
        latencyMs: Math.round(performance.now() - started),
      });
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        // Unauthenticated liveness only: no model or deployment details here.
        const allDown = pool.unavailableModels().length === engine.catalog.models.length;
        sendJson(res, allDown ? 503 : 200, { status: allDown ? "no_models_available" : "ok" });
        return;
      }
      if (!authorized(req, opts.gatewayKey)) {
        sendError(res, 401, "missing or invalid gateway API key");
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/deployments") {
        sendJson(res, 200, { unavailableModels: pool.unavailableModels(), deployments: pool.status() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, { object: "list", data: models() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await chat(req, res, false);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/route/explain") {
        await chat(req, res, true);
        return;
      }
      sendError(res, 404, `no route for ${req.method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof HttpError || e instanceof RequestError) sendError(res, e.status, e.message);
      else {
        console.error(`[chainaim-gateway] ${req.method} ${url.pathname}:`, e);
        sendError(res, 500, "internal gateway error");
      }
    }
  });
}
