import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import {
  callbackSecret,
  encodeIntent,
  intentDigest,
  intentKeyId,
  IntentVerificationError,
  openIntent,
  operationHash,
  Outis,
  parseIntentKey,
  sealIntent,
  unsealIntent,
  type IntentEnvelope,
  type OutisRequest,
} from "../src/index.js";
import { decodeRequest } from "../src/types.js";
import { FakeOutis } from "./fake-outis.js";

interface VectorCase {
  action: string;
  aad_hex: string;
  plaintext: string;
  digest: string;
  envelope: IntentEnvelope;
  params: Record<string, string>;
  operation_hash: string;
}

const vectors = JSON.parse(readFileSync(new URL("../../intent-vectors.json", import.meta.url), "utf8")) as {
  key: string;
  key_url: string;
  key_hex: string;
  kid: string;
  nonce_hex: string;
  intents: VectorCase[];
  callback_secret: { api_key: string; secret_hex: string }[];
};

const fakes: FakeOutis[] = [];
after(() => Promise.all(fakes.map((f) => f.server.close())));

function authorized(v: VectorCase, over: Record<string, unknown> = {}): OutisRequest {
  return decodeRequest({
    id: "req_v",
    action: v.action,
    outcome: "authorized",
    live: false,
    params: v.params,
    operation_hash: v.operation_hash,
    intent: v.envelope,
    ...over,
  });
}

test("the shared vectors reproduce byte for byte", () => {
  assert.equal(intentKeyId(vectors.key), vectors.kid);
  assert.deepEqual(parseIntentKey(vectors.key_url), Buffer.from(vectors.key_hex, "hex"));
  const nonce = Buffer.from(vectors.nonce_hex, "hex");
  for (const v of vectors.intents) {
    const parsed = JSON.parse(v.plaintext);
    assert.equal(encodeIntent({ client: parsed.client, method: parsed.method, args: parsed.args }), v.plaintext);
    assert.equal(intentDigest(v.plaintext), v.digest);
    assert.deepEqual(sealIntent(vectors.key, v.action, v.plaintext, nonce), v.envelope);
    assert.equal(unsealIntent([vectors.key], v.action, v.envelope), v.plaintext);
    assert.equal(operationHash(v.action, v.params), v.operation_hash);
    assert.equal(openIntent([vectors.key], authorized(v)).plaintext, v.plaintext);
  }
});

test("the callback secret matches the server's derivation", () => {
  for (const c of vectors.callback_secret) {
    assert.equal(Buffer.from(callbackSecret(c.api_key)).toString("hex"), c.secret_hex);
  }
});

test("encoding refuses anything that isn't plain JSON data", () => {
  const bad: unknown[] = [() => 1, 1n, NaN, Infinity, new Map(), new (class Money {})(), Symbol("s"), [undefined]];
  for (const arg of bad) {
    assert.throws(() => encodeIntent({ client: "c", method: "m", args: [arg] }), TypeError);
  }
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.throws(() => encodeIntent({ client: "c", method: "m", args: [loop] }), /refers back/);
  assert.equal(
    encodeIntent({ client: "c", method: "m", args: [{ at: new Date(0), skip: undefined }, undefined] }),
    '{"v":1,"client":"c","method":"m","args":[{"at":"1970-01-01T00:00:00.000Z"}]}',
  );
});

test("opening checks key, action, digest, hash and outcome, in that order", () => {
  const v = vectors.intents[0]!;
  const other = Buffer.alloc(32, 7).toString("base64");
  const reason = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof IntentVerificationError);
      return err.reason;
    }
    return "passed";
  };
  assert.equal(reason(() => openIntent([other], authorized(v))), "unknown_key");
  assert.equal(reason(() => openIntent([vectors.key], authorized(v, { action: "stripe.refund" }))), "decrypt_failed");
  const tampered = { ...v.envelope, ciphertext: "A" + v.envelope.ciphertext.slice(1) };
  assert.equal(reason(() => openIntent([vectors.key], authorized(v, { intent: tampered }))), "decrypt_failed");
  const swapped = { ...v.params, intent: vectors.intents[1]!.digest };
  assert.equal(
    reason(() => openIntent([vectors.key], authorized(v, { params: swapped, operation_hash: operationHash(v.action, swapped) }))),
    "digest_mismatch",
  );
  assert.equal(reason(() => openIntent([vectors.key], authorized(v, { operation_hash: "sha256:00" }))), "operation_mismatch");
  assert.equal(reason(() => openIntent([vectors.key], authorized(v, { outcome: "denied" }))), "not_authorized");
  assert.equal(reason(() => openIntent([vectors.key], authorized(v, { intent: null }))), "no_intent");
  assert.equal(reason(() => openIntent([other, vectors.key], authorized(v))), "passed");
});

test("intents.propose seals the call and binds its digest into the params", async () => {
  const fake = await FakeOutis.start();
  fakes.push(fake);
  const outis = new Outis({ apiKey: "k", baseUrl: fake.url, intentKey: vectors.key });
  const pending = await outis.intents.propose(
    {
      action: "stripe.transfer",
      requester: "payouts",
      params: { amount: "25000000", to: "acct_9f2" },
      client: "stripe",
      method: "transfers.create",
      args: [{ amount: 25000000, destination: "acct_9f2" }],
      executeWithin: "7d",
    },
    { idempotencyKey: "payout-42" },
  );
  assert.equal(pending.status, "pending");
  assert.equal(pending.intentDigest, vectors.intents[0]!.digest);
  const post = fake.seen[0]!;
  const body = post.body as Record<string, unknown>;
  assert.equal(post.headers["idempotency-key"], "payout-42");
  assert.equal(body.execute_within, 604800);
  assert.deepEqual(body.params, vectors.intents[0]!.params);
  const envelope = body.intent as IntentEnvelope;
  assert.equal(envelope.kid, vectors.kid);
  assert.notEqual(envelope.nonce, vectors.intents[0]!.envelope.nonce);
  assert.equal(unsealIntent([vectors.key], "stripe.transfer", envelope), vectors.intents[0]!.plaintext);
  assert.equal(pending.request.intent?.kid, vectors.kid);
  assert.equal(pending.request.execution.state, "none");
});

test("intents.propose refuses without a key, and a caller's own params.intent", async () => {
  const input = { action: "a", requester: "r", client: "c", method: "m", args: [] };
  const saved = process.env.OUTIS_INTENT_KEY;
  delete process.env.OUTIS_INTENT_KEY;
  try {
    await assert.rejects(new Outis({ apiKey: "k" }).intents.propose(input), /no intent key/);
  } finally {
    if (saved !== undefined) process.env.OUTIS_INTENT_KEY = saved;
  }
  const outis = new Outis({ apiKey: "k", intentKey: vectors.key });
  await assert.rejects(outis.intents.propose({ ...input, params: { intent: "x" } }), /reserved/);
  assert.throws(() => new Outis({ apiKey: "k", intentKey: "short" }), /32 bytes/);
});

test("opening refuses unknown fields and non-empty kwargs rather than ignoring them", () => {
  const key = vectors.key;
  const open = (plaintext: string) => {
    const action = "stripe.transfer";
    const params = { intent: intentDigest(plaintext) };
    const request = decodeRequest({
      id: "req_k",
      action,
      outcome: "authorized",
      live: false,
      params,
      operation_hash: operationHash(action, params),
      intent: sealIntent(key, action, plaintext),
    });
    try {
      openIntent([key], request);
      return "opened";
    } catch (err) {
      assert.ok(err instanceof IntentVerificationError);
      return `${err.reason}: ${err.message}`;
    }
  };
  const base = '"v":1,"client":"stripe","method":"transfers.create","args":[]';
  assert.equal(open(`{${base},"extra":true}`), "bad_intent: unknown field extra");
  assert.equal(open(`{${base},"kwargs":{"amount":1}}`), "bad_intent: kwargs not supported");
  assert.equal(open(`{${base},"kwargs":null}`), "bad_intent: kwargs not supported");
  assert.equal(open(`{${base},"kwargs":{}}`), "opened");
  assert.equal(open(`{${base}}`), "opened");
});

