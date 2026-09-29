import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operationHash } from "../src/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../vectors.json", import.meta.url), "utf8")) as {
  operation_hash: { action: string; params: Record<string, string>; hash: string }[];
};

test("operation hash matches every shared vector", () => {
  assert.equal(vectors.operation_hash.length, 3);
  for (const v of vectors.operation_hash) {
    assert.equal(operationHash(v.action, v.params), v.hash, v.action);
  }
});

test("operation hash ignores key insertion order", () => {
  const a = operationHash("x", { b: "2", a: "1" });
  const b = operationHash("x", { a: "1", b: "2" });
  assert.equal(a, b);
});

test("operation hash rejects a non-string value", () => {
  assert.throws(() => operationHash("x", { n: 1 as unknown as string }), TypeError);
});
