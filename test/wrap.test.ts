import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  intentDigest,
  NotAuthorizedError,
  Outis,
  unsealIntent,
  type IntentEnvelope,
  type WrapMethods,
} from "../src/index.js";
import { envelope, fakeServer, FakeClock, type Fake, type Reply, type Seen } from "./fake.js";
import { FakeOutis } from "./fake-outis.js";

const KEY = Buffer.alloc(32, 9).toString("base64url");
const servers: Fake[] = [];
const fakes: FakeOutis[] = [];
after(() => Promise.all([...servers.map((s) => s.close()), ...fakes.map((f) => f.server.close())]));

async function setup(handle: (req: Seen, n: number) => Reply) {
  const server = await fakeServer(handle);
  servers.push(server);
  const outis = new Outis({ apiKey: "ok_test_1", baseUrl: server.url, clock: new FakeClock(), intentKey: KEY });
  return { server, outis };
}

class Transfers {
  #secret = "sk_live_customer_owned";
  made: string[] = [];
  create(amount: number, to: string): string {
    this.made.push(`${amount}->${to}:${this.#secret.length}`);
    return `tr_${this.made.length}`;
  }
  list(): string[] {
    return this.made;
  }
}

class Payments {
  #token = "tok";
  transfers = new Transfers();
  refunds = { create: (id: string) => `re_${id}` };
  whoami(): string {
    return this.#token;
  }
}

const methods = {
  "transfers.create": {
    action: "stripe.transfer",
    when: (amount: number) => amount >= 10_000,
    params: (amount: number, to: string) => ({ amount: String(amount), to }),
    requester: "billing-bot",
    summary: (amount: number, to: string) => `Send ${amount} to ${to}`,
    idempotencyKey: (_amount: number, to: string) => `transfer-${to}`,
  },
} satisfies WrapMethods;

test("wait mode asks, then runs the real method with `this` intact", async () => {
  const { server, outis } = await setup((r) =>
    r.method === "POST" ? { status: 202, body: envelope() } : { status: 200, body: envelope({ outcome: "authorized" }) },
  );
  const client = new Payments();
  const guarded = outis.wrap(client, methods, { mode: "wait", timeout: "5m" });
  const id = await guarded.transfers.create(25_000, "acct_9f2");
  assert.equal(id, "tr_1");
  assert.deepEqual(client.transfers.made, ["25000->acct_9f2:22"]);
  const [post] = server.seen;
  assert.deepEqual(post!.body, {
    action: "stripe.transfer",
    requester: "billing-bot",
    params: { amount: "25000", to: "acct_9f2" },
    summary: "Send 25000 to acct_9f2",
  });
  assert.equal(post!.headers["idempotency-key"], "transfer-acct_9f2");
});

test("unlisted methods and properties pass through untouched", async () => {
  const { server, outis } = await setup(() => ({ status: 500 }));
  const client = new Payments();
  const guarded = outis.wrap(client, methods, { mode: "wait", timeout: "5m" });
  assert.equal(guarded.whoami(), "tok");
  assert.equal(guarded.refunds.create("ch_1"), "re_ch_1");
  assert.deepEqual(guarded.transfers.list(), []);
  assert.equal(guarded.transfers, guarded.transfers);
  assert.ok(guarded instanceof Payments);
  assert.equal(server.seen.length, 0);
});

test("when returning false skips Outis entirely", async () => {
  const { server, outis } = await setup(() => ({ status: 500 }));
  const client = new Payments();
  const guarded = outis.wrap(client, methods, { mode: "wait", timeout: "5m" });
  assert.equal(await guarded.transfers.create(50, "acct_small"), "tr_1");
  assert.equal(server.seen.length, 0);
});

test("wait mode never runs the method on a denial", async () => {
  const { outis } = await setup((r) =>
    r.method === "POST" ? { status: 202, body: envelope() } : { status: 200, body: envelope({ outcome: "denied" }) },
  );
  const client = new Payments();
  const guarded = outis.wrap(client, methods, { mode: "wait", timeout: "5m" });
  await assert.rejects(guarded.transfers.create(25_000, "acct_9f2"), NotAuthorizedError);
  assert.deepEqual(client.transfers.made, []);
});

test("durable mode seals the call, proposes it and resolves pending without running", async () => {
  const { server, outis } = await setup(() => ({ status: 202, body: envelope() }));
  const client = new Payments();
  const guarded = outis.wrap(client, methods, { mode: "durable", client: "payments", executeWithin: "2d" });
  const settled = await guarded.transfers.create(25_000, "acct_9f2");
  assert.equal(settled.status, "pending");
  if (settled.status !== "pending") return;
  assert.equal(settled.requestId, "req-1");
  const body = server.seen[0]!.body as { params: Record<string, string>; intent: IntentEnvelope; execute_within: number };
  const plaintext = unsealIntent([KEY], "stripe.transfer", body.intent);
  assert.equal(plaintext, '{"v":1,"client":"payments","method":"transfers.create","args":[25000,"acct_9f2"]}');
  assert.deepEqual(body.params, { amount: "25000", to: "acct_9f2", intent: intentDigest(plaintext) });
  assert.equal(settled.intentDigest, intentDigest(plaintext));
  assert.equal(body.execute_within, 172800);
  assert.equal(server.seen[0]!.headers["idempotency-key"], "transfer-acct_9f2");
  assert.deepEqual(client.transfers.made, []);

  const small = await guarded.transfers.create(50, "acct_small");
  assert.deepEqual(small, { status: "done", result: "tr_1", request: null });
});

test("hybrid mode runs the call itself when authorized in time, under a claim", async () => {
  const fake = await FakeOutis.start();
  fakes.push(fake);
  fake.autoOutcome = "authorized";
  const outis = new Outis({ apiKey: "k", baseUrl: fake.url, intentKey: KEY, clock: new FakeClock() });
  const client = new Payments();
  const guarded = outis.wrap(client, methods, { mode: "hybrid", client: "payments", wait: "45s" });
  const settled = await guarded.transfers.create(25_000, "acct_9f2");
  assert.equal(settled.status, "done");
  if (settled.status === "done") assert.equal(settled.result, "tr_1");
  assert.deepEqual(client.transfers.made, ["25000->acct_9f2:22"]);
  assert.deepEqual(fake.reports.map((r) => r.body.status), ["succeeded"]);
});

test("hybrid mode hands off to a worker when nobody decides in time", async () => {
  const fake = await FakeOutis.start();
  fakes.push(fake);
  const outis = new Outis({ apiKey: "k", baseUrl: fake.url, intentKey: KEY, clock: new FakeClock() });
  const client = new Payments();
  const guarded = outis.wrap(client, methods, { mode: "hybrid", client: "payments", wait: "10s" });
  const settled = await guarded.transfers.create(25_000, "acct_9f2");
  assert.equal(settled.status, "pending");
  assert.deepEqual(client.transfers.made, []);
  assert.ok(!fake.seen.some((s) => s.path.endsWith("/claim")));
});

test("hybrid mode refuses on a denial", async () => {
  const fake = await FakeOutis.start();
  fakes.push(fake);
  fake.autoOutcome = "denied";
  const outis = new Outis({ apiKey: "k", baseUrl: fake.url, intentKey: KEY, clock: new FakeClock() });
  const guarded = outis.wrap(new Payments(), methods, { mode: "hybrid", client: "payments", wait: "10s" });
  await assert.rejects(guarded.transfers.create(25_000, "acct_9f2"), NotAuthorizedError);
});

test("wrap refuses a path that isn't a method, and a wait with no timeout", async () => {
  const { outis } = await setup(() => ({ status: 500 }));
  const client = new Payments();
  const bad = { action: "a", params: () => ({}), requester: "r" };
  assert.throws(() => outis.wrap(client, { "transfers.nope": bad }, { mode: "durable", client: "p" }), /isn't a method/);
  assert.throws(() => outis.wrap(client, { "nope.create": bad }, { mode: "durable", client: "p" }), /doesn't resolve/);
  assert.throws(() => outis.wrap(client, methods, { mode: "propose" } as never), /"wait", "durable" or "hybrid"/);
  assert.throws(() => outis.wrap(client, methods, { mode: "durable" } as never), /options.client/);
  assert.throws(() => outis.wrap(client, methods, { mode: "hybrid", client: "p", wait: "2h" }), /30m cap/);
  assert.throws(() => outis.wrap(client, methods, { mode: "wait" } as never), /timeout is required/);
  assert.throws(() => outis.wrap(client, methods, { mode: "wait", timeout: "45m" }), /30m cap/);
});
