/**
 * Deployment pool (spec section 7, "Cooldown fix"): cooldown ends by itself,
 * failures that mean "back off" act at once, the model list can change at
 * runtime, and OpenRouter deployments are never probed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Deployment } from "../src/catalog.ts";
import { Pool } from "../src/pool.ts";

const openRouter = (id: string): { id: string; deployments: Deployment[] } => ({
  id,
  deployments: [{ id: `${id}@openrouter`, adapter: "openai", baseUrl: "http://127.0.0.1:9/api/v1", servedModel: id, probe: false }],
});
const pool = (cooldownMs: number, unhealthyAfter = 1) =>
  new Pool({ healthIntervalMs: 0, healthTimeoutMs: 200, unhealthyAfter, cooldownMs, env: {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pool", () => {
  it("brings a failed model back after the cooldown, with no probe; the next request is the trial", async () => {
    const p = pool(100);
    p.setModels([openRouter("or/a:free")]);
    p.acquire("or/a:free")!.release("fail", "HTTP 500");
    assert.equal(p.isCoolingDown("or/a:free"), true);
    await sleep(150);
    assert.equal(p.isCoolingDown("or/a:free"), false, "usable again once the cooldown has passed");
    p.acquire("or/a:free")!.release("fail", "HTTP 500");
    assert.equal(p.isCoolingDown("or/a:free"), true, "a failed trial goes straight back into cooldown");
  });

  it("takes a model out at once for 'cooldown', even when unhealthyAfter is higher", () => {
    const p = pool(60_000, 3);
    p.setModels([openRouter("or/a:free")]);
    p.acquire("or/a:free")!.release("fail", "timeout");
    assert.equal(p.isCoolingDown("or/a:free"), false, "one failure of three");
    p.acquire("or/a:free")!.release("cooldown", "HTTP 429");
    assert.equal(p.isCoolingDown("or/a:free"), true);
  });

  it("leaves health alone for 'neutral' and resets it for 'ok'", () => {
    const p = pool(60_000, 2);
    p.setModels([openRouter("or/a:free")]);
    p.acquire("or/a:free")!.release("fail", "timeout");
    p.acquire("or/a:free")!.release("neutral");
    assert.equal(p.status()[0].consecutiveFailures, 1);
    p.acquire("or/a:free")!.release("ok");
    assert.equal(p.status()[0].consecutiveFailures, 0);
  });

  it("keeps the health of deployments that stay when the model list changes", () => {
    const p = pool(60_000);
    p.setModels([openRouter("or/a:free"), openRouter("or/b:free")]);
    p.acquire("or/a:free")!.release("cooldown", "HTTP 429");
    p.setModels([openRouter("or/a:free"), openRouter("or/c:free")]);
    assert.equal(p.isCoolingDown("or/a:free"), true, "a is still cooling down");
    assert.equal(p.acquire("or/b:free"), undefined, "b is gone");
    assert.equal(p.isCoolingDown("or/c:free"), false, "c is new and usable");
    assert.equal(p.isCoolingDown("or/unknown:free"), true, "an unknown model is never usable");
  });

  it("never probes a deployment with probe: false", async () => {
    const p = pool(60_000);
    p.setModels([openRouter("or/a:free")]); // its URL points at a closed port
    await p.checkAll();
    assert.equal(p.isCoolingDown("or/a:free"), false);
  });

  it("still probes catalog deployments", async () => {
    const p = pool(60_000);
    p.setModels([{ id: "local/x", deployments: [{ id: "x@0", adapter: "openai", baseUrl: "http://127.0.0.1:9/v1", servedModel: "x" }] }]);
    await p.checkAll();
    assert.equal(p.isCoolingDown("local/x"), true);
  });
});
