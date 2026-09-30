import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Limits } from "../src/limits.ts";

describe("Limits", () => {
  it("allows up to the per-minute count for one visitor, then refuses", () => {
    let t = 0;
    const l = new Limits(2, 100, () => t);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("a"), "visitor");
  });

  it("does not let one visitor use up another's minute", () => {
    const l = new Limits(1, 100, () => 0);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("b"), undefined);
    assert.equal(l.take("a"), "visitor");
  });

  it("frees the visitor after a minute", () => {
    let t = 0;
    const l = new Limits(1, 100, () => t);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("a"), "visitor");
    t = 60_001;
    assert.equal(l.take("a"), undefined);
  });

  it("caps all visitors together per hour, then frees after an hour", () => {
    let t = 0;
    const l = new Limits(100, 3, () => t);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("b"), undefined);
    assert.equal(l.take("c"), undefined);
    assert.equal(l.take("d"), "hour");
    t = 3_600_001;
    assert.equal(l.take("d"), undefined);
  });

  it("does not record a refused attempt against the hour", () => {
    const l = new Limits(1, 2, () => 0);
    assert.equal(l.take("a"), undefined);
    assert.equal(l.take("a"), "visitor");
    assert.equal(l.take("b"), undefined);
    assert.equal(l.take("c"), "hour");
  });
});
