import assert from "node:assert/strict";
import { after, test } from "node:test";
import { intentDigest, NotAuthorizedError, Outis, unsealIntent, WaitTimeoutError, type Clock, type IntentEnvelope } from "../src/index.js";
import { recipes } from "../src/recipes.js";
import { envelope, fakeServer, FakeClock, type Fake, type Reply, type Seen } from "./fake.js";

const KEY = Buffer.alloc(32, 5).toString("base64");
const servers: Fake[] = [];
after(() => Promise.all(servers.map((s) => s.close())));

async function setup(handle: (req: Seen, n: number) => Reply, clock: Clock = new FakeClock()) {
  const server = await fakeServer(handle);
  servers.push(server);
  const outis = new Outis({ apiKey: "ok_test_1", baseUrl: server.url, clock, intentKey: KEY, requester: "payouts-api" });
  return { server, outis };
}

/** Decides every request with `outcome` once it has been read `after` times. */
function decides(outcome: string | null, after = 0) {
  let reads = 0;
  return (r: Seen): Reply => {
    if (r.method === "POST") return { status: 202, body: envelope() };
    reads++;
    return { status: 200, body: envelope(outcome !== null && reads > after ? { outcome } : {}) };
  };
}

/** A clock that really yields to the event loop on every sleep, so other timers get to run. */
class TickClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        this.t += ms;
        resolve();
      }, 2);
      signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
    });
  }
}

const transfer = { action: "stripe.transfer", showApprovers: { amount: "2500000", currency: "usd", to: "acct_9f2" } };

test("guard needs exactly one of wait or deferTo, and sends nothing otherwise", async () => {
  const { server, outis } = await setup(decides("authorized"));
  await assert.rejects(outis.guard({ ...transfer } as never), /exactly one of wait .* or deferTo/);
  await assert.rejects(
    outis.guard({ ...transfer, wait: "5m", deferTo: { worker: "stripe", call: "transfers.create" } } as never),
    /not both/,
  );
  await assert.rejects(outis.guard({ ...transfer, wait: "2h" }), /30m cap/);
  await assert.rejects(outis.guard({ ...transfer, showApprovers: { amount: 2500000 as never }, wait: "5m" }), /showApprovers.amount must be a string/);
  const anonymous = new Outis({ apiKey: "k", baseUrl: server.url });
  await assert.rejects(anonymous.guard({ ...transfer, wait: "5m" }), /requester is required/);
  assert.equal(server.seen.length, 0);
});

test("wait resolves with the authorized request and shows approvers exactly what the code wrote", async () => {
  const { server, outis } = await setup(decides("authorized", 2));
  const req = await outis.guard({ ...transfer, summary: "Payout", idempotencyKey: "payout-7", wait: "5m" });
  assert.equal(req.isAuthorized, true);
  const [post] = server.seen;
  assert.deepEqual(post!.body, { action: "stripe.transfer", requester: "payouts-api", params: transfer.showApprovers, summary: "Payout" });
  assert.equal(post!.headers["idempotency-key"], "payout-7");
  assert.equal(server.seen.length, 4);
});

for (const outcome of ["denied", "expired", "aborted"] as const) {
  test(`wait rejects with NotAuthorizedError on ${outcome}`, async () => {
    const { outis } = await setup(decides(outcome, 1));
    await assert.rejects(outis.guard({ ...transfer, requester: "keith", wait: "5m" }), (err: unknown) => {
      assert.ok(err instanceof NotAuthorizedError);
      assert.equal(err.outcome, outcome);
      assert.equal(err.request.id, "req-1");
      return true;
    });
  });
}

test("wait rejects with WaitTimeoutError carrying the request id", async () => {
  const { outis } = await setup(decides(null));
  await assert.rejects(outis.guard({ ...transfer, wait: "20s" }), (err: unknown) => {
    assert.ok(err instanceof WaitTimeoutError);
    assert.equal(err.requestId, "req-1");
    return true;
  });
});

test("waiting runs on timers, so the rest of the process keeps going", async () => {
  const { outis } = await setup(decides("authorized", 3), new TickClock());
  const events: string[] = [];
  const pending = outis.guard({ ...transfer, wait: "5m" }).then(() => events.push("approved"));
  const ticker = setInterval(() => events.push("tick"), 1);
  await pending;
  clearInterval(ticker);
  assert.equal(events.at(-1), "approved");
  assert.ok(events.filter((e) => e === "tick").length >= 2, events.join(","));
});

test("aborting the signal stops local polling and leaves the request alone", async () => {
  const { server, outis } = await setup(decides(null), new TickClock());
  const stop = new AbortController();
  const waiting = outis.guard({ ...transfer, wait: "5m", signal: stop.signal });
  while (server.seen.length < 2) await new Promise((r) => setTimeout(r, 1));
  stop.abort(new Error("shutting down"));
  await assert.rejects(waiting, /shutting down/);
  const seen = server.seen.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(server.seen.length, seen);
  assert.ok(server.seen.every((s) => s.method !== "DELETE"));
});

test("deferTo seals the call, binds its digest and returns right after creating the request", async () => {
  const { server, outis } = await setup(decides(null));
  const args = [{ amount: 2500000, currency: "usd", destination: "acct_9f2" }];
  const deferred = await outis.guard({
    ...transfer,
    idempotencyKey: "payout-8",
    deferTo: { worker: "stripe", call: "transfers.create", args, executeWithin: "2d" },
  });
  assert.equal(server.seen.length, 1);
  const body = server.seen[0]!.body as { params: Record<string, string>; intent: IntentEnvelope; execute_within: number };
  const plaintext = unsealIntent([KEY], "stripe.transfer", body.intent);
  assert.equal(plaintext, JSON.stringify({ v: 1, client: "stripe", method: "transfers.create", args }));
  assert.deepEqual(body.params, { ...transfer.showApprovers, intent: intentDigest(plaintext) });
  assert.equal(body.execute_within, 172800);
  assert.equal(server.seen[0]!.headers["idempotency-key"], "payout-8");
  assert.equal(deferred.id, "req-1");
  assert.equal(deferred.request.id, "req-1");
  assert.equal(deferred.intentDigest, intentDigest(plaintext));
});

test("deferTo refuses without an intent key, and args that aren't plain JSON, before sending", async () => {
  const { server, outis } = await setup(decides(null));
  const saved = [process.env.OUTIS_INTENT_KEY, process.env.OUTIS_INTENT_KEYS];
  delete process.env.OUTIS_INTENT_KEY;
  delete process.env.OUTIS_INTENT_KEYS;
  try {
    const keyless = new Outis({ apiKey: "k", baseUrl: server.url, requester: "r" });
    await assert.rejects(keyless.guard({ ...transfer, deferTo: { worker: "stripe", call: "transfers.create" } }), /OUTIS_INTENT_KEY/);
  } finally {
    if (saved[0] !== undefined) process.env.OUTIS_INTENT_KEY = saved[0];
    if (saved[1] !== undefined) process.env.OUTIS_INTENT_KEYS = saved[1];
  }
  await assert.rejects(outis.guard({ ...transfer, deferTo: { worker: "stripe", call: "transfers.create", args: [() => 1] } }), TypeError);
  await assert.rejects(
    outis.guard({ ...transfer, showApprovers: { intent: "x" }, deferTo: { worker: "stripe", call: "transfers.create" } }),
    /reserved/,
  );
  assert.equal(server.seen.length, 0);
});

class Transfers {
  #key = "sk_live_customer_owned";
  made: unknown[] = [];
  async create(params: { amount: number; currency: string; destination: string }, options?: { stripeAccount?: string }) {
    this.made.push([params, options, this.#key.length]);
    return { id: `tr_${this.made.length}`, amount: params.amount };
  }
}

test("guardMethod with wait runs the real method once approved, with `this` intact", async () => {
  const { server, outis } = await setup(decides("authorized", 1));
  const transfers = new Transfers();
  const create = outis.guardMethod(transfers, "create", {
    action: "stripe.transfer",
    showApprovers: (t) => ({ amount: String(t.amount), currency: t.currency, to: t.destination }),
    summary: (t) => `Send ${t.amount} to ${t.destination}`,
    idempotencyKey: (t) => `payout-${t.destination}`,
    wait: "5m",
  });
  const made = await create({ amount: 2500000, currency: "usd", destination: "acct_9f2" });
  assert.equal(made.id, "tr_1");
  assert.deepEqual(transfers.made, [[{ amount: 2500000, currency: "usd", destination: "acct_9f2" }, undefined, 22]]);
  assert.deepEqual((server.seen[0]!.body as { params: unknown }).params, transfer.showApprovers);
  assert.equal(server.seen[0]!.headers["idempotency-key"], "payout-acct_9f2");
});

test("guardMethod with wait never runs the method on a denial", async () => {
  const { outis } = await setup(decides("denied"));
  const transfers = new Transfers();
  const create = outis.guardMethod(transfers, "create", { action: "stripe.transfer", wait: "5m" });
  await assert.rejects(create({ amount: 1, currency: "usd", destination: "acct_1" }), NotAuthorizedError);
  assert.deepEqual(transfers.made, []);
});

test("guardMethod with deferTo seals the call's own arguments and doesn't run it", async () => {
  const { server, outis } = await setup(decides(null));
  const transfers = new Transfers();
  const create = outis.guardMethod(transfers, "create", {
    action: "stripe.transfer",
    requester: (t) => `payouts-${t.currency}`,
    showApprovers: (t) => ({ amount: String(t.amount) }),
    deferTo: { worker: "stripe", call: "transfers.create" },
  });
  const deferred = await create({ amount: 5, currency: "usd", destination: "acct_2" }, { stripeAccount: "acct_p" });
  assert.equal(deferred.id, "req-1");
  const body = server.seen[0]!.body as { requester: string; intent: IntentEnvelope };
  assert.equal(body.requester, "payouts-usd");
  assert.equal(
    unsealIntent([KEY], "stripe.transfer", body.intent),
    '{"v":1,"client":"stripe","method":"transfers.create","args":[{"amount":5,"currency":"usd","destination":"acct_2"},{"stripeAccount":"acct_p"}]}',
  );
  assert.deepEqual(transfers.made, []);
});

test("guardMethod checks its options when it's set up", async () => {
  const { outis } = await setup(decides(null));
  const transfers = new Transfers();
  assert.throws(() => outis.guardMethod(transfers, "create", { action: "a" } as never), /exactly one of/);
  assert.throws(() => outis.guardMethod(transfers, "create", { action: "a", wait: "1h" }), /30m cap/);
  assert.throws(() => outis.guardMethod(transfers, "nope" as never, { action: "a", wait: "1m" }), /isn't a method/);
  assert.throws(() => outis.guardMethod(transfers, "create", { action: "a", deferTo: { worker: "", call: "c" } }), /deferTo.worker/);
});

test("the Stripe recipes show only vetted fields", () => {
  const s = recipes.stripe;
  assert.deepEqual(
    s.transfers.create.showApprovers(
      { amount: 2500000, currency: "usd", destination: "acct_9f2", description: "x".repeat(100), metadata: { note: "secret" } } as never,
      { stripeAccount: "acct_platform", apiKey: "sk_live_x" } as never,
    ),
    { amount: "2500000", currency: "usd", destination: "acct_9f2", description: `${"x".repeat(61)}...`, stripe_account: "acct_platform" },
  );
  assert.deepEqual(s.payouts.create.showApprovers({ amount: 1100, currency: "usd", method: "instant", statement_descriptor: "free text" } as never), {
    amount: "1100",
    currency: "usd",
    method: "instant",
  });
  assert.deepEqual(
    s.refunds.create.showApprovers({ payment_intent: "pi_1", reason: "duplicate", reverse_transfer: true, instructions_email: "a@b.co" } as never),
    { payment_intent: "pi_1", amount: "full", reason: "duplicate", reverse_transfer: "true" },
  );
  assert.deepEqual(s.refunds.create.showApprovers({ charge: "ch_1", amount: 500 }), { charge: "ch_1", amount: "500" });
  assert.deepEqual(s.customers.del.showApprovers("cus_1"), { customer: "cus_1" });
  assert.deepEqual(
    [s.transfers.create.action, s.payouts.create.action, s.refunds.create.action, s.customers.del.action],
    ["stripe.transfers.create", "stripe.payouts.create", "stripe.refunds.create", "stripe.customers.delete"],
  );
});

test("a recipe plugs into guardMethod and fills in the worker call", async () => {
  const { server, outis } = await setup(decides(null));
  const transfers = new Transfers();
  const create = outis.guardMethod(transfers, "create", recipes.stripe.transfers.create({ deferTo: { worker: "stripe" } }));
  await create({ amount: 700, currency: "eur", destination: "acct_3" });
  const body = server.seen[0]!.body as { action: string; params: Record<string, string>; intent: IntentEnvelope };
  assert.equal(body.action, "stripe.transfers.create");
  assert.deepEqual({ ...body.params, intent: undefined }, { amount: "700", currency: "eur", destination: "acct_3", intent: undefined });
  assert.match(unsealIntent([KEY], body.action, body.intent), /"method":"transfers.create"/);
  const waited = recipes.stripe.transfers.create({ requester: "ops", wait: "5m" });
  assert.equal(waited.wait, "5m");
  assert.equal(waited.action, "stripe.transfers.create");
});

test("a recipe refuses a call missing a field Stripe requires, before any request", async () => {
  const { server, outis } = await setup(decides("authorized"));
  const transfers = new Transfers();
  const create = outis.guardMethod(transfers, "create", recipes.stripe.transfers.create({ wait: "5m" }));
  await assert.rejects(create({ amount: 700, currency: "eur" } as never), { name: "TypeError", message: "stripe transfers.create needs destination" });
  assert.equal(server.seen.length, 0);
});
