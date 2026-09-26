/**
 * Free-model quota (spec section 7): the minute window, the daily allowance,
 * pauses after account limits, a rejected key, and capacity().
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startStubOpenRouter, type StubOpenRouter } from "../../../scripts/stub-openrouter.ts";
import { Quota } from "../src/routing/quota.ts";

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("Quota", () => {
  let or: StubOpenRouter;
  before(async () => {
    or = await startStubOpenRouter();
  });
  after(() => or.close());
  beforeEach(() => {
    or.key = { status: 200, remaining: 1000 };
  });
  const withKey = (c: ReturnType<typeof clock>) => new Quota({ rpm: 1000, keyIntervalMs: 0, keyUrl: `${or.url}/api/v1/key`, apiKey: "sk-or-test", now: c.now });

  it("allows rpm calls in any 60-second window", () => {
    const c = clock();
    const q = new Quota({ rpm: 3, keyIntervalMs: 0, now: c.now });
    assert.deepEqual([q.take(), q.take(), q.take(), q.take()], [true, true, true, false]);
    assert.deepEqual(q.capacity(true), { chatAvailable: false, reason: "rate_limited", retryAfterSec: 60 });
    c.advance(30_000);
    assert.equal(q.capacity(true).retryAfterSec, 30);
    c.advance(30_000);
    assert.equal(q.take(), true);
  });

  it("pauses for 60 seconds after an account per-minute limit", () => {
    const c = clock();
    const q = new Quota({ rpm: 20, keyIntervalMs: 0, now: c.now });
    q.onAccountLimit("minute");
    assert.equal(q.take(), false);
    assert.deepEqual(q.capacity(true), { chatAvailable: false, reason: "rate_limited", retryAfterSec: 60 });
    c.advance(60_001);
    assert.equal(q.take(), true);
  });

  it("counts the daily allowance down between key reads", async () => {
    or.key.remaining = 2;
    const q = withKey(clock());
    await q.refresh();
    assert.deepEqual([q.take(), q.take(), q.take()], [true, true, false]);
    assert.deepEqual(q.capacity(true), { chatAvailable: false, reason: "daily_exhausted" });
    or.key.remaining = 5;
    await q.refresh();
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("after an account per-day limit, waits for a key read that shows allowance", async () => {
    or.key.remaining = 0;
    const q = withKey(clock());
    q.onAccountLimit("day");
    await q.refresh();
    assert.equal(q.capacity(true).reason, "daily_exhausted");
    or.key.remaining = 900;
    await q.refresh();
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("a rejected key makes chat unavailable until a key read succeeds", async () => {
    or.key.status = 401;
    const q = withKey(clock());
    await q.refresh();
    assert.deepEqual(q.capacity(true), { chatAvailable: false, reason: "key_rejected" });
    or.key.status = 200;
    await q.refresh();
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("onKeyRejected blocks at once and starts a key read", async () => {
    const q = withKey(clock());
    const reads = or.keyReads;
    q.onKeyRejected();
    assert.equal(q.capacity(true).reason, "key_rejected");
    await q.refresh(); // the key is fine, so chat comes back
    assert.ok(or.keyReads > reads);
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("key reads never overlap: a burst asks for one more read, not one each", async () => {
    const q = withKey(clock());
    const reads = or.keyReads;
    await Promise.all([q.refresh(), q.refresh(), q.refresh()]);
    assert.equal(or.keyReads - reads, 2);
  });

  it("without a key reader (catalog mode) a rejected key does not latch", () => {
    const q = new Quota({ rpm: 20, keyIntervalMs: 0 });
    q.onKeyRejected();
    assert.equal(q.capacity(true).chatAvailable, true);
  });

  it("reports no models before the pool is ready", () => {
    assert.deepEqual(new Quota({ rpm: 20, keyIntervalMs: 0 }).capacity(false), { chatAvailable: false, reason: "no_models" });
  });
});
