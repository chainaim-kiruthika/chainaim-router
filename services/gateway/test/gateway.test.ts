/**
 * Gateway tests in catalog mode: upstreams are real HTTP servers on loopback
 * ports that behave like OpenAI-compatible model servers (healthy, failing,
 * slow), so fallback, cooldown, the key and the ledger run over real sockets.
 * Chat always runs the privacy pipeline (the stub Presidio); Jev is off, so
 * the rules classify.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { CatalogError, validateCatalog, type Catalog } from "../src/catalog.ts";
import { parseFlags } from "../src/main.ts";
import { closeServer, ledgerText, listen, post, startTestGateway } from "./helpers.ts";

type Behaviour = "ok" | "fail500" | "slow";

async function upstream(name: string, behaviour: Behaviour): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(behaviour === "fail500" ? 503 : 200).end("{}");
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (behaviour === "fail500") {
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
      return;
    }
    if (behaviour === "slow") await new Promise((r) => setTimeout(r, 400));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: `hi from ${name}` } }] }));
  });
  return { server, url: await listen(server) };
}

const caps = { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: true, supportsVision: false };
const chains = (order: string[]) => ({ SIMPLE: order, MEDIUM: order, COMPLEX: order, REASONING: order });
const profiles = (ids: string[]) => ({ auto: chains(ids), eco: chains(ids), premium: chains(ids) });

function catalogFor(small: string[], large: string[]): Catalog {
  const deployments = (name: string, urls: string[]) =>
    urls.map((u, i) => ({ id: `${name}@${i}`, adapter: "openai", baseUrl: `${u}/v1`, servedModel: name, healthUrl: `${u}/health` }));
  return validateCatalog({
    version: "test",
    models: [
      { id: "local/small", zone: "local", capabilities: caps, pricing: { inputPerM: 0.01, outputPerM: 0.02 }, deployments: deployments("small", small) },
      { id: "local/large", zone: "local", capabilities: caps, pricing: { inputPerM: 0.1, outputPerM: 0.2 }, deployments: deployments("large", large) },
    ],
    profiles: profiles(["local/small", "local/large"]),
  });
}

describe("catalog validation", () => {
  const one = (deployment: Record<string, unknown>, id = "local/a") => ({
    version: "x",
    models: [{ id, zone: "local", capabilities: caps, pricing: { inputPerM: 0, outputPerM: 0 }, deployments: [{ id: "a", adapter: "openai", baseUrl: "http://127.0.0.1:1/v1", servedModel: "a", ...deployment }] }],
    profiles: profiles([id]),
  });

  it("rejects an unknown model id in a profile chain", () => {
    assert.throws(() => validateCatalog({ ...one({}), profiles: { ...profiles(["local/a"]), auto: chains(["local/nope"]) } }), CatalogError);
  });
  it("rejects a secret value where an env var name is expected", () => {
    assert.throws(() => validateCatalog(one({ apiKeyEnv: "sk-live-123" })), /environment variable NAME/);
  });
  it("reserves the chainaim/ namespace", () => {
    assert.throws(() => validateCatalog(one({}, "chainaim/auto")), /reserved/);
  });
  it("accepts probe: false and rejects a probe that is not a boolean", () => {
    assert.equal(validateCatalog(one({ probe: false })).models[0].deployments[0].probe, false);
    assert.throws(() => validateCatalog(one({ probe: "no" })), /probe/);
  });
});

describe("flags", () => {
  it("default to catalog mode with the spec's values", () => {
    const f = parseFlags([]);
    assert.deepEqual(
      [f.modelSource, f.maxOutputTokens, f.presidioThreshold, f.jev, f.jevModel, f.jevTimeoutMs, f.healthFlagThreshold, f.freeSyncIntervalMs, f.freeRpm, f.openRouterKeyEnv],
      ["catalog", 1024, 0.4, true, "typesafe/jev-1.13", 800, 0.5, 21_600_000, 20, "OPENROUTER_API_KEY"],
    );
  });
  it("reject an unknown model source, a threshold above 1 and a key where a variable name belongs", () => {
    assert.throws(() => parseFlags(["--model-source", "paid"]), /model-source/);
    assert.throws(() => parseFlags(["--presidio-threshold", "2"]), /presidio-threshold/);
    assert.throws(() => parseFlags(["--openrouter-key-env", "sk-or-v1-abc"]), /openrouter-key-env/);
  });
});

describe("catalog-mode chat over real sockets", () => {
  let presidio: StubPresidio;
  const ups: { server: Server; url: string }[] = [];
  before(async () => {
    presidio = await startStubPresidio();
    ups.push(await upstream("small-ok", "ok"), await upstream("large-ok", "ok"), await upstream("small-down", "fail500"), await upstream("slow", "slow"));
  });
  after(async () => {
    await Promise.all(ups.map((u) => closeServer(u.server)));
    await presidio.close();
  });
  const start = (catalog: Catalog, extra: { attemptTimeoutMs?: number; gatewayKey?: string } = {}) => startTestGateway({ presidioUrl: presidio.url, catalog, ...extra });
  const ask = (url: string, content: string, headers: Record<string, string> = {}) => post(`${url}/v1/chat/completions`, { messages: [{ role: "user", content }] }, headers);

  it("serves the best-scored model and reports the decision in headers", async () => {
    const g = await start(catalogFor([ups[0].url], [ups[1].url]));
    const r = await ask(g.url, "What is 2+2?");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/small");
    assert.equal(r.headers.get("x-chainaim-classifier"), "rules");
    assert.equal(r.headers.get("x-chainaim-data-class"), "none");
    assert.equal(r.headers.get("x-chainaim-attempts"), "1");
    assert.equal((await r.json()).model, "small", "the upstream received the deployment's servedModel");
    await g.close();
  });

  it("falls back to the next model on a 5xx and cools the first one down", async () => {
    const g = await start(catalogFor([ups[2].url], [ups[1].url]));
    const r = await ask(g.url, "What is 2+2?");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/large");
    assert.equal(r.headers.get("x-chainaim-attempts"), "2");
    assert.equal(g.pool.isCoolingDown("local/small"), true);
    await g.close();
  });

  it("uses the healthy replica of a model before changing model", async () => {
    const g = await start(catalogFor([ups[2].url, ups[0].url], [ups[1].url]));
    await g.pool.checkAll(); // the probe takes small@0 out before any request
    const r = await ask(g.url, "What is 2+2?");
    assert.equal(r.headers.get("x-chainaim-model"), "local/small");
    assert.equal(r.headers.get("x-chainaim-attempts"), "1");
    await g.close();
  });

  it("times out a slow model and falls back", async () => {
    const g = await start(catalogFor([ups[3].url], [ups[1].url]), { attemptTimeoutMs: 100 });
    const r = await ask(g.url, "What is 2+2?");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-chainaim-model"), "local/large");
    await g.close();
  });

  it("answers 503 with the attempt count when every model fails", async () => {
    const g = await start(catalogFor([ups[2].url], [ups[2].url]));
    const r = await ask(g.url, "hi");
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("x-chainaim-attempts"), "2");
    await g.close();
  });

  it("emulates streaming: one chunk, then [DONE]", async () => {
    const g = await start(catalogFor([ups[0].url], [ups[1].url]));
    const r = await post(`${g.url}/v1/chat/completions`, { stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const text = await r.text();
    assert.match(text, /hi from small-ok/);
    assert.ok(text.endsWith("data: [DONE]\n\n"));
    await g.close();
  });

  it("enforces the gateway key; /healthz stays open", async () => {
    const g = await start(catalogFor([ups[0].url], [ups[1].url]), { gatewayKey: "test-key-123" });
    assert.equal((await ask(g.url, "hi")).status, 401);
    assert.equal((await ask(g.url, "hi", { authorization: "Bearer test-key-123" })).status, 200);
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200);
    await g.close();
  });

  it("writes a ledger line with no prompt text", async () => {
    const g = await start(catalogFor([ups[0].url], [ups[1].url]));
    const secret = "Patient Jane Roe MRN 991122";
    await (await ask(g.url, secret)).text();
    const text = ledgerText(g.ledgerDir);
    assert.ok(!text.includes("Jane") && !text.includes("991122"), "the ledger holds no prompt text");
    const entry = JSON.parse(text.trim());
    assert.deepEqual([entry.served, entry.promptChars, entry.dataClass], ["local/small", secret.length, "PHI"]);
    await g.close();
  });
});
