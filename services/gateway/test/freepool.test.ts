/**
 * The free pool (spec section 6): which OpenRouter models count, how a sync
 * keeps the last good list, and the catalog source used for tests and local runs.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { catalogSource, FreePool, openRouterDeployments, parseFreeModels, type FreeModel } from "../src/routing/freepool.ts";
import { closeServer, listen } from "./helpers.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  context_length: 32768,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  top_provider: { context_length: 32768, max_completion_tokens: 4096 },
  supported_parameters: ["max_tokens", "tools", "response_format"],
  ...extra,
});

describe("parseFreeModels", () => {
  it("keeps a free text model and records its limits and features", () => {
    const [m] = parseFreeModels({ data: [model("acme/big-70b:free")] });
    assert.deepEqual(m, { id: "acme/big-70b:free", contextLength: 32768, maxOutput: 4096, tools: true, json: true });
  });

  it("drops paid models, excluded names and models without text output", () => {
    const got = parseFreeModels({
      data: [
        model("acme/paid-70b"),
        model("nvidia/guard-content-safety:free"),
        model("stealth/zeta:free"),
        model("openrouter/auto:free"),
        model("acme/image-gen:free", { architecture: { input_modalities: ["text"], output_modalities: ["image"] } }),
        model("acme/ok-8b:free"),
      ],
    });
    assert.deepEqual(got.map((m) => m.id), ["acme/ok-8b:free"]);
  });

  it("uses the context length when no output limit is given, and counts structured_outputs as JSON", () => {
    const [m] = parseFreeModels({ data: [model("acme/x:free", { top_provider: {}, supported_parameters: ["structured_outputs"] })] });
    assert.deepEqual([m.maxOutput, m.tools, m.json], [32768, false, true]);
  });

  it("sorts by id and rejects a body without a data array", () => {
    assert.deepEqual(parseFreeModels({ data: [model("b/y:free"), model("a/x:free")] }).map((m) => m.id), ["a/x:free", "b/y:free"]);
    assert.throws(() => parseFreeModels({}), /data/);
  });
});

describe("FreePool", () => {
  let reply: { status: number; body: unknown } = { status: 200, body: { data: [] } };
  const server = createServer((_req, res) => {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  let url = "";
  before(async () => {
    url = await listen(server);
  });
  after(() => closeServer(server));

  it("is not ready until a sync succeeds; then it lists the models and calls onChange", async () => {
    const seen: FreeModel[][] = [];
    const pool = new FreePool({ baseUrl: url, intervalMs: 0, timeoutMs: 2000, onChange: (m) => seen.push(m) });
    assert.equal(pool.ready(), false);
    reply = { status: 200, body: { data: [model("acme/a:free")] } };
    assert.equal(await pool.sync(), true);
    assert.equal(pool.ready(), true);
    assert.deepEqual(pool.models().map((m) => m.id), ["acme/a:free"]);
    assert.equal(seen.length, 1);
  });

  it("keeps the last good list when a sync fails or finds nothing", async () => {
    const pool = new FreePool({ baseUrl: url, intervalMs: 0, timeoutMs: 2000, onChange: () => {} });
    reply = { status: 200, body: { data: [model("acme/a:free")] } };
    await pool.sync();
    for (const r of [{ status: 500, body: {} }, { status: 200, body: { data: [] } }, { status: 200, body: { oops: true } }]) {
      reply = r;
      assert.equal(await pool.sync(), false);
      assert.deepEqual(pool.models().map((m) => m.id), ["acme/a:free"]);
    }
  });

  it("fails a sync when OpenRouter cannot be reached", async () => {
    const pool = new FreePool({ baseUrl: "http://127.0.0.1:9", intervalMs: 0, timeoutMs: 300, onChange: () => {} });
    assert.equal(await pool.sync(), false);
    assert.equal(pool.ready(), false);
  });
});

describe("model sources", () => {
  it("gives each OpenRouter model one unprobed deployment that reads the key variable", () => {
    const [d] = openRouterDeployments([{ id: "acme/a:free", contextLength: 1, maxOutput: 1, tools: false, json: false }], "https://openrouter.ai/", "OPENROUTER_API_KEY");
    assert.deepEqual(d, {
      id: "acme/a:free",
      deployments: [{ id: "acme/a:free@openrouter", adapter: "openai", baseUrl: "https://openrouter.ai/api/v1", servedModel: "acme/a:free", apiKeyEnv: "OPENROUTER_API_KEY", probe: false }],
    });
  });

  it("turns the catalog into an always-ready source", () => {
    const source = catalogSource(loadCatalog("config/catalog.json"));
    assert.equal(source.ready(), true);
    assert.deepEqual(source.models().map((m) => m.id), ["local/qwen2.5-0.5b", "local/qwen2.5-1.5b"]);
    assert.equal(source.models()[0].contextLength, 4096);
  });
});
