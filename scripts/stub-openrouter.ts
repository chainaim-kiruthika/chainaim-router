/**
 * Stub OpenRouter for tests and local runs: the public model list, the key
 * endpoint, chat completions and the Decisions API (Jev). It records every
 * body it receives, so tests can prove what left the gateway.
 *
 *   node scripts/stub-openrouter.ts [--port 5003]
 *
 * Chat behaviour per model id (chatModes, default "ok"):
 *   ok             "echo: <last user text>"; with tools and "call lookup" in the
 *                  last user text, a lookup tool call carrying that text instead
 *   account429     429 free-models-per-min      account429day  429 free-models-per-day
 *   provider429    429 with metadata.provider_name
 *   policy404      404 data policy, for deny requests (allow requests are served)
 *   policy503      503 routing requirements, for deny requests
 *   unauthorized   401     server500   500     badrequest   400
 *   slow           answers after 1.5 s     notjson   200 with a body that is not JSON
 *   gone404        404 "No endpoints found for <model>." for any request
 *   moderation403  403 with moderation metadata (the input was flagged)
 *   restricted403  403 "only available on agentic harnesses", with routing metadata (the key is fine, the model is gated)
 *   empty          200 with no content and no tool call (a reasoning model out of tokens)
 * Jev (jev.mode): ok | slow | fail500 | malformed, answering jev.task,
 * jev.difficulty (1 to 5) and jev.health.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

export type ChatMode = "ok" | "account429" | "account429day" | "provider429" | "policy404" | "policy503" | "unauthorized" | "server500" | "badrequest" | "slow" | "notjson" | "gone404" | "empty" | "moderation403" | "restricted403";
export type JevMode = "ok" | "slow" | "fail500" | "malformed";
export type StubOpenRouter = {
  url: string;
  models: unknown[];
  chatModes: Record<string, ChatMode>;
  chatBodies: Record<string, unknown>[];
  decisionBodies: Record<string, unknown>[];
  authorizations: string[];
  jev: { mode: JevMode; task: string; difficulty: number; health: number };
  key: { status: number; remaining: number };
  keyReads: number;
  close: () => Promise<void>;
};

const freeModel = (id: string, contextLength: number, maxOut: number, params: string[]) => ({
  id,
  name: id,
  context_length: contextLength,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0", completion: "0" },
  top_provider: { context_length: contextLength, max_completion_tokens: maxOut },
  supported_parameters: params,
});

/** Three usable free models, and three the gateway must leave out. */
export const STUB_MODELS: readonly unknown[] = [
  freeModel("stub/alpha-70b:free", 131072, 8192, ["max_tokens", "tools", "tool_choice", "response_format"]),
  freeModel("stub/bravo-27b:free", 65536, 4096, ["max_tokens", "tools", "tool_choice"]),
  freeModel("stub/charlie-8b:free", 32768, 2048, ["max_tokens"]),
  freeModel("stub/guard-content-safety:free", 8192, 1024, ["max_tokens"]),
  freeModel("stealth/zeta:free", 8192, 1024, ["max_tokens"]),
  { ...freeModel("stub/paid-model", 8192, 1024, ["max_tokens"]), pricing: { prompt: "0.000001", completion: "0.000002" } },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref()); // a slow answer nobody waits for must not keep a process alive
const error = (code: number, message: string, metadata: Record<string, unknown> = {}) => ({ error: { code, message, metadata } });

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((p: { text?: string }) => p?.text ?? "").join("\n");
  }
  return "";
}

function completion(body: Record<string, unknown>): Record<string, unknown> {
  const text = lastUserText(body);
  const toolCall = Array.isArray(body.tools) && body.tools.length > 0 && text.includes("call lookup");
  const message = toolCall
    ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ query: text }) } }] }
    : { role: "assistant", content: `echo: ${text}` };
  return {
    id: "gen-stub-1",
    object: "chat.completion",
    created: 1790000000,
    model: body.model,
    provider: "StubCloud",
    choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function decision(jev: StubOpenRouter["jev"]): unknown {
  const difficulty = Object.fromEntries([0, 1, 2, 3, 4].map((i) => [String(i), i === jev.difficulty - 1 ? 0.9 : 0.025]));
  return {
    id: "gen-dec-stub",
    model: "typesafe/jev-1.13-20260901",
    provider: "TypeSafe",
    answers: {
      task: { type: "choice", choice: jev.task, probabilities: { [jev.task]: 0.9 }, confidence: 0.8 },
      difficulty: { type: "score", score: jev.difficulty - 1, probabilities: difficulty, confidence: 0.9 },
      health: { type: "noul", noul: jev.health },
    },
    usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 },
  };
}

export function startStubOpenRouter(port = 0, host = "127.0.0.1"): Promise<StubOpenRouter> {
  const stub: StubOpenRouter = {
    url: "",
    models: [...STUB_MODELS],
    chatModes: {},
    chatBodies: [],
    decisionBodies: [],
    authorizations: [],
    jev: { mode: "ok", task: "chat", difficulty: 1, health: 0.05 },
    key: { status: 200, remaining: 1000 },
    keyReads: 0,
    close: async () => {},
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://stub.local").pathname;
    if (req.method === "GET" && path === "/api/v1/models") return json(res, 200, { data: stub.models });
    const auth = req.headers.authorization ?? "";
    stub.authorizations.push(auth);
    if (!auth.startsWith("Bearer ")) return json(res, 401, error(401, "No auth credentials found"));

    if (req.method === "GET" && path === "/api/v1/key") {
      stub.keyReads++;
      if (stub.key.status !== 200) return json(res, stub.key.status, error(stub.key.status, "stub key status"));
      const daily = { used: 1000 - stub.key.remaining, limit: 1000, remaining: stub.key.remaining };
      return json(res, 200, { data: { label: "stub", limit: null, usage: 0, is_free_tier: false, free_model_daily_requests: daily } });
    }

    if (req.method === "POST" && path === "/api/alpha/decisions") {
      stub.decisionBodies.push(await readJson(req));
      if (stub.jev.mode === "fail500") return json(res, 500, error(500, "stub jev failure"));
      if (stub.jev.mode === "malformed") return json(res, 200, { id: "gen-dec-stub", answers: { task: { type: "choice", choice: "banana" } } });
      if (stub.jev.mode === "slow") await sleep(1500);
      return json(res, 200, decision(stub.jev));
    }

    if (req.method === "POST" && path === "/api/v1/chat/completions") {
      const body = await readJson(req);
      stub.chatBodies.push(body);
      const deny = (body.provider as { data_collection?: string } | undefined)?.data_collection === "deny";
      switch (stub.chatModes[String(body.model)] ?? "ok") {
        case "account429":
          return json(res, 429, error(429, "Rate limit exceeded: free-models-per-min. ", { error_type: "rate_limit_exceeded" }));
        case "account429day":
          return json(res, 429, error(429, "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", { error_type: "rate_limit_exceeded" }));
        case "provider429":
          return json(res, 429, error(429, "Provider returned error", { error_type: "rate_limit_exceeded", provider_name: "StubCloud", raw: "temporarily rate-limited upstream" }));
        case "policy404":
          if (deny) return json(res, 404, error(404, "No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy"));
          break;
        case "policy503":
          if (deny) return json(res, 503, error(503, "There is no available model provider that meets your routing requirements"));
          break;
        case "unauthorized":
          return json(res, 401, error(401, "User not found."));
        case "server500":
          return json(res, 500, error(500, "Internal Server Error"));
        case "badrequest":
          return json(res, 400, error(400, "Invalid tool schema"));
        case "slow":
          await sleep(1500);
          break;
        case "notjson":
          res.writeHead(200, { "content-type": "application/json" });
          res.end("<html>oops</html>");
          return;
        case "gone404":
          return json(res, 404, error(404, `No endpoints found for ${String(body.model)}.`));
        case "moderation403":
          return json(res, 403, error(403, "Your chosen model requires moderation and your input was flagged", { reasons: ["harassment"], flagged_input: "[synthetic]", provider_name: "StubCloud" }));
        case "restricted403":
          return json(res, 403, error(403, `${String(body.model)} is only available on agentic harnesses. Try plugging it into a coding agent or productivity app.`, { routing_funnel: [{ step: "Initial Endpoints", endpoint_count: 1 }] }));
        case "empty": {
          const message = { role: "assistant", content: null, reasoning: "Working through the steps first." };
          return json(res, 200, { ...completion(body), choices: [{ index: 0, message, finish_reason: "length" }] });
        }
        default:
          break;
      }
      return json(res, 200, completion(body));
    }
    json(res, 404, error(404, `stub: no route ${req.method} ${path}`));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      stub.url = `http://${host}:${(server.address() as AddressInfo).port}`;
      stub.close = () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
      resolve(stub);
    });
  });
}

if (import.meta.main ?? process.argv[1]?.endsWith("stub-openrouter.ts")) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "5003" }, host: { type: "string", default: "127.0.0.1" } } });
  const stub = await startStubOpenRouter(Number(values.port), values.host);
  console.log(`[stub-openrouter] ${stub.url}  (synthetic; ${stub.models.length} models listed)`);
}
