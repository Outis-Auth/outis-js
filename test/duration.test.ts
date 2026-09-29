import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "../src/index.js";

test("durations parse from numbers and strings", () => {
  assert.equal(parseDuration(1500), 1500);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("1m30s"), 90_000);
  assert.equal(parseDuration("1.5s"), 1_500);
  assert.equal(parseDuration("7d"), 604_800_000);
});

test("durations refuse what they can't read", () => {
  for (const bad of ["", "5", "5 minutes", "m5", "5w", "-1s"]) {
    assert.throws(() => parseDuration(bad), TypeError, bad);
  }
  assert.throws(() => parseDuration(-1), TypeError);
  assert.throws(() => parseDuration(Number.NaN), TypeError);
});
