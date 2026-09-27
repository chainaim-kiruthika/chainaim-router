/**
 * Presidio client: offsets, overlaps, fail closed, and the start-up check (V4).
 * Runs against the stub Presidio over a real socket.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { startStubPresidio, type StubPresidio } from "../../../scripts/stub-presidio.ts";
import { AD_HOC_RECOGNIZERS, DETECTED_ENTITIES } from "../src/privacy/entities.ts";
import { PresidioClient, PresidioError, postProcess, resolveOverlaps, waitForPresidio } from "../src/privacy/presidio.ts";
import { CORPUS, KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { verifyPresidio } from "../../../scripts/verify-presidio.ts";
import { closeServer, leaked, listen } from "./helpers.ts";

describe("resolveOverlaps", () => {
  it("keeps the longer of two overlapping spans", () => {
    const kept = resolveOverlaps([
      { type: "PERSON", start: 0, end: 4, score: 0.9 },
      { type: "HEALTH_TERM", start: 0, end: 11, score: 0.5 },
    ]);
    assert.deepEqual(kept.map((s) => s.type), ["HEALTH_TERM"]);
  });

  it("breaks an equal-length tie by score", () => {
    const kept = resolveOverlaps([
      { type: "US_DRIVER_LICENSE", start: 5, end: 13, score: 0.4 },
      { type: "MEDICAL_RECORD", start: 5, end: 13, score: 0.45 },
    ]);
    assert.deepEqual(kept.map((s) => s.type), ["MEDICAL_RECORD"]);
  });

  it("keeps spans that don't overlap, sorted by start", () => {
    const kept = resolveOverlaps([
      { type: "EMAIL_ADDRESS", start: 20, end: 30, score: 1 },
      { type: "PERSON", start: 0, end: 8, score: 0.85 },
    ]);
    assert.deepEqual(kept.map((s) => s.start), [0, 20]);
  });
});

describe("postProcess", () => {
  it("converts Presidio's code-point offsets to UTF-16 around an emoji", () => {
    const text = "🙂 Thanks, Jane Roe!";
    // Presidio counts the emoji as one character, so "Jane Roe" starts at code point 10.
    const [d] = postProcess(text, [{ type: "PERSON", start: 10, end: 18, score: 0.85 }]);
    assert.equal(text.slice(d.start, d.end), "Jane Roe");
  });

  it("trims whitespace at the edges of a span", () => {
    const [d] = postProcess("Hi  Jane Roe ", [{ type: "PERSON", start: 2, end: 13, score: 0.9 }]);
    assert.deepEqual([d.start, d.end], [4, 12]);
  });

  it("rejects an offset outside the text", () => {
    assert.throws(() => postProcess("abc", [{ type: "PERSON", start: 1, end: 9, score: 1 }]), PresidioError);
  });
});

describe("PresidioClient against the stub", () => {
  let stub: StubPresidio;
  let client: PresidioClient;
  before(async () => {
    stub = await startStubPresidio();
    client = new PresidioClient({ url: stub.url, threshold: 0.4, timeoutMs: 2000 });
  });
  after(() => stub.close());
  afterEach(() => {
    stub.mode = "ok";
  });

  it("finds corpus values and health terms with UTF-16 offsets", async () => {
    const text = "🙂 Thanks, Jane Roe! Your asthma inhaler refill is ready.";
    const found = await client.analyze(text);
    assert.deepEqual(
      found.map((e) => [e.type, text.slice(e.start, e.end)]),
      [["PERSON", "Jane Roe"], ["HEALTH_TERM", "asthma"], ["HEALTH_TERM", "inhaler"]],
    );
  });

  it("sends the threshold, the language, the entity list and the ad-hoc recognizers", async () => {
    stub.requests.length = 0;
    await client.analyze("Call Jane Roe.");
    const sent = stub.requests[0];
    assert.equal(sent.language, "en");
    assert.equal(sent.score_threshold, 0.4);
    assert.deepEqual(sent.entities, DETECTED_ENTITIES);
    assert.deepEqual(sent.ad_hoc_recognizers, AD_HOC_RECOGNIZERS);
  });

  it("does not call Presidio for blank text", async () => {
    stub.requests.length = 0;
    assert.deepEqual(await client.analyze("   "), []);
    assert.equal(stub.requests.length, 0);
  });

  it("analyzeAll keeps the input order", async () => {
    const [a, b, c] = await client.analyzeAll(["Tom Baker", "", "Maria Garcia and Tom Baker"]);
    assert.deepEqual([a.length, b.length, c.length], [1, 0, 2]);
  });

  it("analyzeAll for a caller who has gone sends nothing and leaves health alone", async () => {
    assert.equal(await client.checkHealth(), true);
    stub.requests.length = 0;
    await assert.rejects(client.analyzeAll(["Tom Baker", "Maria Garcia"], AbortSignal.abort()), PresidioError);
    assert.equal(stub.requests.length, 0);
    assert.equal(client.healthy, true);
  });

  it("fails closed: a Presidio error is a PresidioError and marks it unhealthy", async () => {
    stub.mode = "fail";
    await assert.rejects(client.analyze("Jane Roe"), PresidioError);
    assert.equal(client.healthy, false);
  });

  it("rejects a malformed entity instead of skipping it", async () => {
    stub.mode = "malformed";
    await assert.rejects(client.analyze("Jane Roe"), PresidioError);
  });

  it("checkHealth follows /health", async () => {
    assert.equal(await client.checkHealth(), true);
    stub.mode = "fail";
    assert.equal(await client.checkHealth(), false);
  });

  it("waitForPresidio passes when every required entity is supported and the test sentence is detected", async () => {
    stub.requests.length = 0;
    await waitForPresidio(client, 1000, 10);
    assert.equal(stub.requests.length, 1, "one /analyze call for the test sentence");
  });

  it("waitForPresidio refuses to start when a required entity is missing", async () => {
    stub.mode = "missing-entities";
    await assert.rejects(waitForPresidio(client, 1000, 10), /IN_AADHAAR/);
  });

  it("waitForPresidio refuses to start when Presidio answers but detects nothing, naming only the entity types", async () => {
    stub.mode = "detect-nothing";
    await assert.rejects(waitForPresidio(client, 1000, 10), (e: Error) => {
      assert.match(e.message, /did not detect PERSON, EMAIL_ADDRESS, MEDICAL_RECORD in the start-up test sentence/);
      assert.deepEqual(leaked(e.message), [], "the message holds none of the sentence's values");
      return true;
    });
  });
});

describe("analyzeAll after a failed call", () => {
  it("starts no new call once one has failed", async () => {
    // "fail" is refused at once; any other text is answered after 100 ms
    const texts: string[] = [];
    const answered = new EventTarget();
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { text } = JSON.parse(raw) as { text: string };
      texts.push(text);
      if (text === "fail") return void res.writeHead(500).end("{}");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" }).end("[]");
        answered.dispatchEvent(new Event("answer"));
      }, 100);
    });
    const url = await listen(server);
    try {
      const client = new PresidioClient({ url, threshold: 0.4, timeoutMs: 2000, concurrency: 2 });
      const first = once(answered, "answer");
      await assert.rejects(client.analyzeAll(["fail", "a", "b", "c", "d"]), PresidioError);
      await first; // "a" is answered; a worker that ignored the failure would now send "b"
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(texts.sort(), ["a", "fail"]);
    } finally {
      await closeServer(server);
    }
  });
});

describe("waitForPresidio without a Presidio", () => {
  it("gives up after waitMs", async () => {
    const client = new PresidioClient({ url: "http://127.0.0.1:9", threshold: 0.4, timeoutMs: 200 });
    await assert.rejects(waitForPresidio(client, 100, 20), /did not answer/);
  });
});

describe("scripts/verify-presidio.ts", () => {
  let stub: StubPresidio;
  before(async () => {
    stub = await startStubPresidio();
  });
  after(() => stub.close());

  it("passes against a Presidio that supports every entity and classifies the corpus", async () => {
    const { ok, lines } = await verifyPresidio(stub.url);
    assert.equal(ok, true, lines.join("\n"));
    assert.equal(lines.length, CORPUS.length + 1);
  });

  it("fails when a required entity is missing, and never prints corpus text", async () => {
    stub.mode = "missing-entities";
    try {
      const { ok, lines } = await verifyPresidio(stub.url);
      assert.equal(ok, false);
      assert.match(lines[0], /IN_AADHAAR/);
      const printed = lines.join("\n");
      for (const { value } of KNOWN_VALUES) assert.ok(!printed.includes(value), `${value} printed`);
    } finally {
      stub.mode = "ok";
    }
  });
});
