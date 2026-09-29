import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { callbackSecret, intentDigest, Outis, sealIntent, withIdempotencyKey, type ExecutionContext, type ExecutionResult } from "../src/index.js";
import { FakeClock } from "./fake.js";
import { FakeOutis } from "./fake-outis.js";

const KEY = Buffer.alloc(32, 1).toString("base64");
const fakes: FakeOutis[] = [];
after(() => Promise.all(fakes.map((f) => f.server.close())));

class Stripe {
  calls: unknown[][] = [];
  transfers = {
    create: async (...args: unknown[]) => {
      this.calls.push(args);
      return { id: `tr_${this.calls.length}`, object: "transfer" };
    },
  };
}

async function setup() {
  const fake = await FakeOutis.start();
  fakes.push(fake);
  const outis = new Outis({ apiKey: "outis_sk_test", baseUrl: fake.url, intentKey: KEY, clock: new FakeClock() });
  return { fake, outis };
}

async function proposeTransfer(outis: Outis, args: unknown[] = [{ amount: 25000000, destination: "acct_9f2" }]) {
  return outis.intents.propose({
    action: "stripe.transfer",
    requester: "payouts",
    params: { amount: "25000000", to: "acct_9f2" },
    client: "stripe",
    method: "transfers.create",
    args,
  });
}

test("execute claims, runs the registered client with the request id as Stripe's key, and reports", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const results: ExecutionResult[] = [];
  const worker = outis.worker({
    clients: { stripe: { client: stripe, idempotency: "stripe" } },
    onResult: (r) => void results.push(r),
  });
  const { requestId } = await proposeTransfer(outis);
  fake.decide(requestId, "authorized");

  const result = await worker.execute(requestId);
  assert.equal(result.status, "succeeded");
  assert.equal(result.reference, "tr_1");
  assert.equal(result.reported, true);
  assert.deepEqual(stripe.calls, [[{ amount: 25000000, destination: "acct_9f2" }, { idempotencyKey: requestId }]]);
  assert.deepEqual(fake.reports, [{ id: requestId, body: { claim_id: "clm_1", status: "succeeded", reference: "tr_1" } }]);
  assert.deepEqual(results.map((r) => r.status), ["succeeded"]);

  const again = await worker.execute(requestId);
  assert.equal(again.status, "skipped");
  assert.equal(again.reason, "already_reported");
  assert.equal(stripe.calls.length, 1);
});

test("a bare client gets the args untouched; a handler gets the context first", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const seen: ExecutionContext[] = [];
  const worker = outis.worker({
    clients: { stripe },
    handlers: {
      "db.restore": (ctx, db: string) => {
        seen.push(ctx);
        return { id: `restore_${db}` };
      },
    },
  });
  const a = await proposeTransfer(outis);
  const b = await outis.intents.propose({
    action: "db.restore",
    requester: "keith",
    params: { db: "payments" },
    client: "db",
    method: "restore",
    args: ["payments"],
  });
  fake.decide(a.requestId, "authorized");
  fake.decide(b.requestId, "authorized");
  assert.equal((await worker.execute(a.requestId)).status, "succeeded");
  assert.deepEqual(stripe.calls, [[{ amount: 25000000, destination: "acct_9f2" }]]);
  const r = await worker.execute(b.requestId);
  assert.equal(r.reference, "restore_payments");
  assert.equal(seen[0]!.idempotencyKey, b.requestId);
  assert.equal(seen[0]!.method, "restore");
});

test("a run that throws, an unregistered client and a disallowed method report failed without running", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const boom = { transfers: { create: async () => { throw new Error("card_declined"); } } };
  const failing = outis.worker({ clients: { stripe: boom } });
  const p1 = await proposeTransfer(outis);
  fake.decide(p1.requestId, "authorized");
  const r1 = await failing.execute(p1.requestId);
  assert.equal(r1.status, "failed");
  assert.equal(r1.reason, "execution_error");
  assert.equal(fake.reports[0]!.body.error, "execution_error: card_declined");

  const other = outis.worker({ clients: { db: {} } });
  const p2 = await proposeTransfer(outis);
  fake.decide(p2.requestId, "authorized");
  assert.equal((await other.execute(p2.requestId)).reason, "client_not_registered");

  const narrow = outis.worker({ clients: { stripe }, allow: ["stripe.refunds.*"] });
  const p3 = await proposeTransfer(outis);
  fake.decide(p3.requestId, "authorized");
  assert.equal((await narrow.execute(p3.requestId)).reason, "not_allowed");

  const p4 = await outis.intents.propose({ action: "x", requester: "r", client: "stripe", method: "constructor", args: [] });
  fake.decide(p4.requestId, "authorized");
  assert.equal((await narrow.execute(p4.requestId)).reason, "not_allowed");
  const open = outis.worker({ clients: { stripe } });
  const p5 = await outis.intents.propose({ action: "x", requester: "r", client: "stripe", method: "constructor", args: [] });
  fake.decide(p5.requestId, "authorized");
  assert.equal((await open.execute(p5.requestId)).reason, "client_not_registered");
  assert.equal(stripe.calls.length, 0);
});

test("a worker holding a different key reports unknown_key and never runs", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const { requestId } = await proposeTransfer(outis);
  fake.decide(requestId, "authorized");
  const stranger = new Outis({ apiKey: "k", baseUrl: fake.url, intentKey: Buffer.alloc(32, 2) });
  const r = await stranger.worker({ clients: { stripe } }).execute(requestId);
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "unknown_key");
  assert.match(String(fake.reports[0]!.body.error), /^unknown_key: /);
  assert.equal(stripe.calls.length, 0);
});

test("an unauthorized request is skipped, not reported", async () => {
  const { fake, outis } = await setup();
  const { requestId } = await proposeTransfer(outis);
  const r = await outis.worker({ clients: { stripe: new Stripe() } }).execute(requestId);
  assert.deepEqual([r.status, r.reason], ["skipped", "not_authorized"]);
  assert.equal(fake.reports.length, 0);
});

test("run drains what's executable and stops on abort", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const { requestId } = await proposeTransfer(outis);
    fake.decide(requestId, "authorized");
    ids.push(requestId);
  }
  const stop = new AbortController();
  const done: string[] = [];
  const worker = outis.worker({
    clients: { stripe },
    concurrency: 2,
    onResult: (r) => {
      done.push(r.requestId);
      if (done.length === 5) stop.abort();
    },
  });
  await worker.run({ every: "1s", signal: stop.signal });
  assert.deepEqual(done.sort(), ids.sort());
  assert.equal(stripe.calls.length, 5);
});

function sign(key: string | Uint8Array, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
}

function event(request: unknown, type = "request.authorized"): string {
  return JSON.stringify({ id: "evt_1", type, created_at: "2026-09-27T12:00:00Z", org: "org_1", data: { request } });
}

test("fetchHandler verifies the delivery and executes on request.authorized", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const { requestId } = await proposeTransfer(outis);
  fake.decide(requestId, "authorized");
  const secret = "whsec_test";
  const handle = outis.worker({ clients: { stripe } }).fetchHandler([secret, callbackSecret("outis_sk_test")]);
  const body = event(fake.requests.get(requestId)!.wire);

  const bad = await handle(new Request("http://x/hook", { method: "POST", body, headers: { "outis-signature": sign("nope", body) } }));
  assert.equal(bad.status, 400);
  assert.equal(stripe.calls.length, 0);

  const good = await handle(
    new Request("http://x/hook", { method: "POST", body, headers: { "outis-signature": sign(callbackSecret("outis_sk_test"), body) } }),
  );
  assert.equal(good.status, 200);
  assert.equal(((await good.json()) as { result: ExecutionResult }).result.status, "succeeded");
  assert.equal(stripe.calls.length, 1);

  const other = event(fake.requests.get(requestId)!.wire, "request.executed");
  const ignored = await handle(new Request("http://x/hook", { method: "POST", body: other, headers: { "outis-signature": sign(secret, other) } }));
  assert.deepEqual(await ignored.json(), { ignored: "request.executed" });
});

test("handler works as a plain node http handler", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const { requestId } = await proposeTransfer(outis);
  fake.decide(requestId, "authorized");
  const server = createServer(outis.worker({ clients: { stripe } }).handler("whsec_test"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    const body = event(fake.requests.get(requestId)!.wire);
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers: { "outis-signature": sign("whsec_test", body) } });
    assert.equal(res.status, 200);
    assert.equal(stripe.calls.length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("withIdempotencyKey merges into Stripe options, appends when there are none, and keeps a caller's key", () => {
  assert.deepEqual(withIdempotencyKey([{ amount: 1 }], "req_1", "stripe"), [{ amount: 1 }, { idempotencyKey: "req_1" }]);
  assert.deepEqual(withIdempotencyKey([], "req_1", "stripe"), [{ idempotencyKey: "req_1" }]);
  assert.deepEqual(withIdempotencyKey(["ch_1", { stripeAccount: "acct_1" }], "req_1", "stripe"), [
    "ch_1",
    { stripeAccount: "acct_1", idempotencyKey: "req_1" },
  ]);
  assert.deepEqual(withIdempotencyKey([{ a: 1 }, { idempotencyKey: "mine" }], "req_1", "stripe"), [{ a: 1 }, { idempotencyKey: "mine" }]);
});

test("a worker needs a key and something to run", () => {
  const outis = new Outis({ apiKey: "k", intentKey: KEY });
  assert.throws(() => outis.worker({}), /at least one client/);
});

test("a worker reports an intent with kwargs as bad_intent and never runs it", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const plaintext = '{"v":1,"client":"stripe","method":"transfers.create","args":[],"kwargs":{"amount":1}}';
  const params = { intent: intentDigest(plaintext) };
  const created = await outis.requests.create({
    action: "stripe.transfer",
    requester: "payouts",
    params,
    intent: sealIntent(KEY, "stripe.transfer", plaintext),
  });
  fake.decide(created.id, "authorized");
  const r = await outis.worker({ clients: { stripe } }).execute(created.id);
  assert.deepEqual([r.status, r.reason], ["failed", "bad_intent"]);
  assert.equal(fake.reports[0]!.body.error, "bad_intent: kwargs not supported");
  assert.equal(stripe.calls.length, 0);
});

test("start runs until SIGTERM, drains, and removes its signal listeners", async () => {
  const { fake, outis } = await setup();
  const stripe = new Stripe();
  const before = process.listenerCount("SIGTERM");
  const { requestId } = await proposeTransfer(outis);
  fake.decide(requestId, "authorized");
  const worker = outis.worker({ clients: { stripe }, onResult: () => void process.emit("SIGTERM") });
  await worker.start({ every: "1s" });
  assert.equal(stripe.calls.length, 1);
  assert.equal(process.listenerCount("SIGTERM"), before);
});
