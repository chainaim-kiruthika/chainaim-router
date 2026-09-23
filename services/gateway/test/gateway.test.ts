/**
 * Gateway tests. Upstreams are real HTTP servers on loopback ports that
 * behave like OpenAI-compatible model servers (healthy, failing, slow), so
 * fallback, health and streaming are exercised over real sockets.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CatalogError, loadCatalog, validateCatalog, type Catalog } from "../src/catalog.ts";
import { Engine, extractFeatures, RequestError } from "../src/engine.ts";
import { Ledger } from "../src/ledger.ts";
import { Pool } from "../src/pool.ts";
import { createGateway } from "../src/server.ts";

type Behaviour = "ok" | "fail500" | "slow";

function upstream(name: string, behaviour: Behaviour): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(behaviour === "fail500" ? 503 : 200).end("{}");
      return;
    }
    hits++;
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (behaviour === "fail500") {
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
      return;
    }
    if (behaviour === "slow") await new Promise((r) => setTimeout(r, 400));
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"choices":[{"delta":{"content":"hi from ${name}"}}]}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: `hi from ${name}` } }] }));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, hits: () => hits });
    }),
  );
}

const caps = { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: false, supportsVision: false };
const chains = (order: string[]) => ({ SIMPLE: order, MEDIUM: order, COMPLEX: order, REASONING: order });

/** @param agentic tier chains for tool-bearing turns; omit to leave agentic routing off */
function catalogFor(small: string[], large: string[], agentic?: string[]): Catalog {
  return validateCatalog({
    version: "test",
    models: [
      { id: "local/small", zone: "local", capabilities: { ...caps, supportsTools: true }, pricing: { inputPerM: 0.01, outputPerM: 0.02 },
        deployments: small.map((u, i) => ({ id: `small@${i}`, adapter: "openai", baseUrl: `${u}/v1`, servedModel: "small", healthUrl: `${u}/health` })) },
      { id: "local/large", zone: "local", capabilities: { ...caps, supportsTools: true }, pricing: { inputPerM: 0.1, outputPerM: 0.2 },
        deployments: large.map((u, i) => ({ id: `large@${i}`, adapter: "openai", baseUrl: `${u}/v1`, servedModel: "large", healthUrl: `${u}/health` })) },
    ],
    profiles: { auto: chains(["local/small", "local/large"]), eco: chains(["local/small", "local/large"]), premium: chains(["local/large", "local/small"]) },
    ...(agentic ? { agentic: chains(agentic) } : {}),
  });
}

const TOOLS = [{ type: "function", function: { name: "cancel_order" } }];
const AGENT_PROMPT = "Cancel order B-42 and book the 9am flight to SFO.";

async function startGateway(catalog: Catalog, extra: Partial<{ attemptTimeoutMs: number; gatewayKey: string; ledgerDir: string }> = {}) {
  const engine = new Engine(catalog, { strategy: "rules", defaultProfile: "auto", defaultMaxTokens: 256 });
  const pool = new Pool(catalog, { healthIntervalMs: 0, healthTimeoutMs: 1000, unhealthyAfter: 1, cooldownMs: 60_000, env: {} });
  const server = createGateway(engine, pool, new Ledger(extra.ledgerDir), {
    maxAttempts: 3, attemptTimeoutMs: extra.attemptTimeoutMs ?? 5000, maxBodyBytes: 1 << 20, gatewayKey: extra.gatewayKey,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, pool, url };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("catalog validation", () => {
  it("rejects an unknown model id in a profile chain", () => {
    const bad = { version: "x", models: [{ id: "local/a", zone: "local", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 },
      deployments: [{ id: "a", adapter: "openai", baseUrl: "http://127.0.0.1:1/v1", servedModel: "a" }] }],
      profiles: { auto: chains(["local/nope"]), eco: chains(["local/a"]), premium: chains(["local/a"]) } };
    assert.throws(() => validateCatalog(bad), CatalogError);
  });
  it("rejects a secret value where an env var name is expected", () => {
    const bad = { version: "x", models: [{ id: "local/a", zone: "local", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 },
      deployments: [{ id: "a", adapter: "openai", baseUrl: "http://127.0.0.1:1/v1", servedModel: "a", apiKeyEnv: "sk-live-123" }] }],
      profiles: { auto: chains(["local/a"]), eco: chains(["local/a"]), premium: chains(["local/a"]) } };
    assert.throws(() => validateCatalog(bad), /environment variable NAME/);
  });
  it("reserves the chainaim/ namespace", () => {
    const bad = { version: "x", models: [{ id: "chainaim/auto", zone: "local", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 },
      deployments: [{ id: "a", adapter: "openai", baseUrl: "http://127.0.0.1:1/v1", servedModel: "a" }] }],
      profiles: { auto: chains(["chainaim/auto"]), eco: chains(["chainaim/auto"]), premium: chains(["chainaim/auto"]) } };
    assert.throws(() => validateCatalog(bad), /reserved/);
  });
});

/**
 * The shipped catalogs are the deployed artefact, so their routing is asserted
 * directly. A tool-bearing turn must not be served by the weakest model just
 * because the prompt scores SIMPLE: "cancel this order" is a stateful action.
 */
describe("shipped catalogs route agentic work to the larger model", () => {
  const SMALL = "local/qwen2.5-0.5b";
  const LARGE = "local/qwen2.5-1.5b";
  const agenticRequest = {
    model: "chainaim/auto",
    messages: [{ role: "user", content: "Cancel order B-42 and book the 9am flight to SFO." }],
    tools: [
      { type: "function", function: { name: "cancel_order" } },
      { type: "function", function: { name: "book_flight" } },
    ],
  };

  for (const path of ["config/catalog.json", "config/catalog.ollama.json"]) {
    describe(path, () => {
      const catalog = loadCatalog(path);

      it("declares tool support, which both Qwen2.5 models have", () => {
        for (const m of catalog.models) {
          assert.equal(m.capabilities.supportsTools, true, `${m.id}.capabilities.supportsTools`);
        }
      });

      it("routes a tool-bearing request to the larger model", () => {
        const engine = new Engine(catalog, { strategy: "rules", defaultProfile: "auto", defaultMaxTokens: 256 });
        const { decision } = engine.decide(agenticRequest, []);
        assert.equal(decision.chain[0], LARGE);
      });

      it("fails closed: the agentic chain never falls back to the small model", () => {
        const engine = new Engine(catalog, { strategy: "rules", defaultProfile: "auto", defaultMaxTokens: 256 });
        const { decision } = engine.decide(agenticRequest, []);
        assert.ok(!decision.chain.includes(SMALL), `chain must exclude ${SMALL}, got ${JSON.stringify(decision.chain)}`);
      });

      it("leaves ordinary prompts on the cost-optimised chains", () => {
        const engine = new Engine(catalog, { strategy: "rules", defaultProfile: "auto", defaultMaxTokens: 256 });
        const { decision } = engine.decide({ model: "chainaim/auto", messages: [{ role: "user", content: "What is the capital of France?" }] }, []);
        assert.equal(decision.chain[0], SMALL);
      });
    });
  }
});

describe("engine", () => {
  const catalog = catalogFor(["http://127.0.0.1:1"], ["http://127.0.0.1:2"]);
  const engine = new Engine(catalog, { strategy: "rules", defaultProfile: "auto", defaultMaxTokens: 256 });

  it("routes a simple question to the SIMPLE chain, catalog models only", () => {
    const { decision } = engine.decide({ model: "chainaim/auto", messages: [{ role: "user", content: "What is the capital of France?" }] }, []);
    assert.equal(decision.tier, "SIMPLE");
    assert.deepEqual(decision.chain, ["local/small", "local/large"]);
  });
  it("uses the premium chain order for chainaim/premium", () => {
    const { decision } = engine.decide({ model: "chainaim/premium", messages: [{ role: "user", content: "hello" }] }, []);
    assert.equal(decision.chain[0], "local/large");
  });
  it("pins an explicit catalog model", () => {
    const { decision } = engine.decide({ model: "local/large", messages: [{ role: "user", content: "hi" }] }, []);
    assert.deepEqual(decision, { mode: "pinned", chain: ["local/large"], excluded: [] });
  });
  it("rejects unknown models and profiles with 404", () => {
    assert.throws(() => engine.decide({ model: "openai/gpt-x", messages: [{ role: "user", content: "hi" }] }, []), (e: unknown) => e instanceof RequestError && e.status === 404);
    assert.throws(() => engine.decide({ model: "chainaim/cheapest", messages: [{ role: "user", content: "hi" }] }, []), (e: unknown) => e instanceof RequestError && e.status === 404);
  });
  it("portfolio strategy never proposes an id outside the catalog", () => {
    const pe = new Engine(catalog, { strategy: "portfolio", defaultProfile: "auto", defaultMaxTokens: 256 });
    const { decision } = pe.decide({ model: "chainaim/auto", messages: [{ role: "user", content: "Refactor this python function to be async and add tests" }] }, []);
    for (const m of decision.chain) assert.ok(["local/small", "local/large"].includes(m), m);
  });
  it("extracts tools, vision and structured-output flags", () => {
    const f = extractFeatures({ messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url" }] }],
      tools: [{ type: "function", function: { name: "get_weather" } }], response_format: { type: "json_schema" } }, 100);
    assert.equal(f.hasVision, true);
    assert.equal(f.hasTools, true);
    assert.deepEqual(f.toolNames, ["get_weather"]);
    assert.equal(f.requiresStructuredOutput, true);
    assert.equal(f.maxOutputTokens, 100);
  });
});

describe("gateway over real sockets", () => {
  const ups: Awaited<ReturnType<typeof upstream>>[] = [];
  before(async () => {
    ups.push(await upstream("small-ok", "ok"), await upstream("large-ok", "ok"), await upstream("small-down", "fail500"), await upstream("slow", "slow"));
  });
  after(() => ups.forEach((u) => u.server.close()));

  it("serves from the primary and reports the decision in headers", async () => {
    const g = await startGateway(catalogFor([ups[0].url], [ups[1].url]));
    const r = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", messages: [{ role: "user", content: "What is 2+2?" }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/small");
    assert.equal(r.headers.get("x-chainaim-tier"), "SIMPLE");
    const j = await r.json();
    assert.equal(j.model, "small", "upstream received the deployment's servedModel");
    g.server.close();
  });

  it("falls back to the next model when the primary returns 5xx", async () => {
    const g = await startGateway(catalogFor([ups[2].url], [ups[1].url]));
    const r = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", messages: [{ role: "user", content: "What is 2+2?" }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/large");
    assert.equal(r.headers.get("x-chainaim-attempts"), "2");
    assert.deepEqual(g.pool.unavailableModels(), ["local/small"], "failed deployment is in cooldown");
    g.server.close();
  });

  it("uses the healthy replica of the same model before changing model", async () => {
    const g = await startGateway(catalogFor([ups[2].url, ups[0].url], [ups[1].url]));
    await g.pool.checkAll(); // health probe marks small@0 down before any request
    const r = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", messages: [{ role: "user", content: "What is 2+2?" }] });
    assert.equal(r.headers.get("x-chainaim-model"), "local/small");
    assert.equal(r.headers.get("x-chainaim-deployment"), "small@1");
    g.server.close();
  });

  it("times out a slow deployment and falls back", async () => {
    const g = await startGateway(catalogFor([ups[3].url], [ups[1].url]), { attemptTimeoutMs: 100 });
    const r = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", messages: [{ role: "user", content: "What is 2+2?" }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/large");
    g.server.close();
  });

  it("returns the last upstream status with attempts when every model fails", async () => {
    const g = await startGateway(catalogFor([ups[2].url], [ups[2].url]));
    const r = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 500);
    assert.equal(r.headers.get("x-chainaim-attempts"), "2");
    g.server.close();
  });

  it("streams server-sent events through unchanged", async () => {
    const g = await startGateway(catalogFor([ups[0].url], [ups[1].url]));
    const r = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const text = await r.text();
    assert.match(text, /hi from small-ok/);
    assert.match(text, /\[DONE\]/);
    g.server.close();
  });

  it("explain returns the decision without calling any model", async () => {
    const g = await startGateway(catalogFor([ups[0].url], [ups[1].url]));
    const before = ups[0].hits();
    const r = await post(`${g.url}/v1/route/explain`, { model: "chainaim/auto", messages: [{ role: "user", content: "Prove that the sum of two odd integers is even, step by step." }] });
    const j = await r.json();
    assert.equal(j.decision.tier, "REASONING");
    assert.equal(j.request.prompt, undefined, "prompt text is not echoed");
    assert.equal(ups[0].hits(), before);
    g.server.close();
  });

  it("enforces the gateway key when configured", async () => {
    const g = await startGateway(catalogFor([ups[0].url], [ups[1].url]), { gatewayKey: "test-key-123" });
    const body = { messages: [{ role: "user", content: "hi" }] };
    assert.equal((await post(`${g.url}/v1/chat/completions`, body)).status, 401);
    assert.equal((await post(`${g.url}/v1/chat/completions`, body, { authorization: "Bearer test-key-123" })).status, 200);
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200, "liveness stays open");
    g.server.close();
  });

  it("serves a tool-bearing request from the agentic chain, not the cheap tier", async () => {
    const g = await startGateway(catalogFor([ups[0].url], [ups[1].url], ["local/large"]));
    const r = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", messages: [{ role: "user", content: AGENT_PROMPT }], tools: TOOLS });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/large", "agentic work must not land on the small model");
    assert.equal(r.headers.get("x-chainaim-profile"), "agentic");
    g.server.close();
  });

  it("fails closed when the agentic model is down, while ordinary prompts still route", async () => {
    // large is the only agentic rung and it is unhealthy; small is healthy.
    const g = await startGateway(catalogFor([ups[0].url], [ups[2].url], ["local/large"]));
    const agentic = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", messages: [{ role: "user", content: AGENT_PROMPT }], tools: TOOLS });
    assert.ok(agentic.status >= 500, `stateful action must not be downgraded to the small model, got ${agentic.status}`);
    assert.notEqual(agentic.headers.get("x-chainaim-model"), "local/small");

    const ordinary = await post(`${g.url}/v1/chat/completions`, { model: "chainaim/auto", messages: [{ role: "user", content: "What is 2+2?" }] });
    assert.equal(ordinary.status, 200, "non-tool traffic is unaffected by the agentic outage");
    assert.equal(ordinary.headers.get("x-chainaim-model"), "local/small");
    g.server.close();
  });

  it("writes a ledger line with no prompt text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chainaim-ledger-"));
    const g = await startGateway(catalogFor([ups[0].url], [ups[1].url]), { ledgerDir: dir });
    const secret = "Patient Jane Roe MRN 991122";
    await (await post(`${g.url}/v1/chat/completions`, { messages: [{ role: "user", content: secret }] })).text();
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const text = readFileSync(join(dir, files[0]), "utf8");
    assert.ok(!text.includes("Jane") && !text.includes("991122"), "ledger must not contain prompt text");
    const entry = JSON.parse(text.trim());
    assert.equal(entry.served.model, "local/small");
    assert.equal(entry.request.promptChars, secret.length);
    g.server.close();
  });
});
