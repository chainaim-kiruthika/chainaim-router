/**
 * Scan and mask over real sockets, against the stub Presidio and the
 * synthetic corpus: classes, placeholders, the 400/413/503 refusals, the
 * Presidio-driven /healthz, and a ledger with no text (launch gate 3).
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { CORPUS, KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { restoreText } from "../src/privacy/restore.ts";
import { ledgerText, post, startTestGateway, withCardsRemoved, type TestGateway } from "./helpers.ts";

describe("scan and mask", () => {
  let stub: StubPresidio;
  let g: TestGateway;
  before(async () => {
    stub = await startStubPresidio();
    g = await startTestGateway({ presidioUrl: stub.url });
  });
  after(async () => {
    await g.close();
    await stub.close();
  });
  afterEach(() => {
    stub.mode = "ok";
  });

  for (const item of CORPUS) {
    it(`scan classifies ${item.id}`, async () => {
      const r = await post(`${g.url}/v1/privacy/scan`, { text: item.text });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.dataClass, item.expect.dataClass);
      assert.deepEqual(j.found, item.expect.found);
      assert.equal(j.policy.dataCollection, item.expect.dataClass === "PHI" ? "deny" : "allow");
      assert.equal(r.headers.get("x-chainaim-decision-id"), j.decisionId);
      for (const e of j.entities) assert.ok(e.end > e.start && typeof e.score === "number" && typeof e.type === "string");
    });

    it(`mask hides every value in ${item.id} and restores exactly`, async () => {
      const j = await (await post(`${g.url}/v1/privacy/mask`, { text: item.text })).json();
      for (const { value } of KNOWN_VALUES) assert.ok(!j.maskedText.includes(value), `${value} leaked`);
      assert.equal(restoreText(j.maskedText, j.map, { unresolved: 0 }), withCardsRemoved(item.text));
    });
  }

  it("returns the numbered placeholders, the map and the counts", async () => {
    const j = await (await post(`${g.url}/v1/privacy/mask`, { text: "Jane Roe met Maria Garcia; later Jane Roe emailed jane.roe@example.com." })).json();
    assert.equal(j.maskedText, "<PERSON_1> met <PERSON_2>; later <PERSON_1> emailed <EMAIL_ADDRESS_1>.");
    assert.deepEqual(j.map, { "<PERSON_1>": "Jane Roe", "<PERSON_2>": "Maria Garcia", "<EMAIL_ADDRESS_1>": "jane.roe@example.com" });
    assert.deepEqual(j.counts, { PERSON: 3, EMAIL_ADDRESS: 1 });
    assert.equal(j.cardsRemoved, 0);
  });

  it("removes card numbers and never puts them in the map", async () => {
    const j = await (await post(`${g.url}/v1/privacy/mask`, { text: "Card 4111 1111 1111 1111 was charged $42 for Arjun Mehta." })).json();
    assert.equal(j.maskedText, "Card [CARD REMOVED] was charged $42 for <PERSON_1>.");
    assert.equal(j.cardsRemoved, 1);
    assert.deepEqual(j.map, { "<PERSON_1>": "Arjun Mehta" });
  });

  it("rejects missing, empty, non-string and oversized text with 400", async () => {
    for (const body of [{}, { text: "" }, { text: 42 }, { text: "x".repeat(20_001) }, []]) {
      assert.equal((await post(`${g.url}/v1/privacy/scan`, body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
  });

  it("rejects a body over the size limit with 413", async () => {
    assert.equal((await post(`${g.url}/v1/privacy/mask`, { text: "x".repeat(1_100_000) })).status, 413);
  });

  it("fails closed: with Presidio down, scan and mask answer 503 without echoing the text", async () => {
    stub.mode = "fail";
    for (const path of ["/v1/privacy/scan", "/v1/privacy/mask"]) {
      const r = await post(`${g.url}${path}`, { text: "Jane Roe" });
      assert.equal(r.status, 503);
      assert.ok(!(await r.text()).includes("Jane"), "the error does not echo the text");
    }
  });

  it("healthz follows Presidio's last check", async () => {
    await g.presidio.checkHealth();
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200);
    stub.mode = "fail";
    await g.presidio.checkHealth();
    const down = await fetch(`${g.url}/healthz`);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { status: "privacy_scanner_unavailable" });
    stub.mode = "ok";
    await g.presidio.checkHealth();
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200);
  });

  it("launch gate 3: no identifier, placeholder or map in the ledger", () => {
    // Every test above wrote ledger lines through this gateway.
    const text = ledgerText(g.ledgerDir);
    assert.ok(text.length > 0);
    for (const { value } of KNOWN_VALUES) assert.ok(!text.includes(value), `${value} is in the ledger`);
    assert.ok(!/<[A-Z_]+_\d+>/.test(text), "a placeholder is in the ledger");
    for (const line of text.trim().split("\n")) {
      const e = JSON.parse(line);
      assert.ok(["scan", "mask"].includes(e.endpoint));
      assert.equal(typeof e.textChars, "number");
      for (const k of ["text", "maskedText", "map", "entities"]) assert.ok(!(k in e), `${k} is in a ledger line`);
    }
  });
});

describe("scan and mask behind the gateway key", () => {
  let stub: StubPresidio;
  let g: TestGateway;
  before(async () => {
    stub = await startStubPresidio();
    g = await startTestGateway({ presidioUrl: stub.url, gatewayKey: "test-key-123" });
  });
  after(async () => {
    await g.close();
    await stub.close();
  });

  it("needs the key; /healthz stays open", async () => {
    assert.equal((await post(`${g.url}/v1/privacy/scan`, { text: "hi" })).status, 401);
    assert.equal((await post(`${g.url}/v1/privacy/scan`, { text: "hi" }, { authorization: "Bearer test-key-123" })).status, 200);
    assert.equal((await fetch(`${g.url}/healthz`)).status, 200);
  });
});
