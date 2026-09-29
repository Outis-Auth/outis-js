import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  IdempotencyConflictError,
  NotAuthorizedError,
  OperationMismatchError,
  Outis,
  OutisApiError,
  WaitTimeoutError,
} from "../src/index.js";
import { envelope, fakeServer, FakeClock, type Fake, type Reply, type Seen } from "./fake.js";

const servers: Fake[] = [];
after(() => Promise.all(servers.map((s) => s.close())));

async function setup(handle: (req: Seen, n: number) => Reply) {
  const server = await fakeServer(handle);
  servers.push(server);
  const clock = new FakeClock();
  const outis = new Outis({ apiKey: "ok_test_1", baseUrl: server.url, clock });
  return { server, clock, outis };
}

const deploy = {
  action: "deploy.production",
  requester: "keith",
  params: { repo: "acme/payments-api", env: "production", sha: "8d93f71" },
};

test("create posts the proposal and reads the request back", async () => {
  const { server, outis } = await setup(() => ({ status: 202, body: envelope() }));
  const req = await outis.requests.create({ ...deploy, summary: "Ship it", callbackUrl: "https://example.com/cb", quorum: 2 });
  const [call] = server.seen;
  assert.equal(call!.method, "POST");
  assert.equal(call!.path, "/v1/requests");
  assert.equal(call!.headers.authorization, "Bearer ok_test_1");
  assert.equal(call!.headers["idempotency-key"], undefined);
  assert.deepEqual(call!.body, {
    action: "deploy.production",
    requester: "keith",
    params: deploy.params,
    summary: "Ship it",
    callback_url: "https://example.com/cb",
    quorum: 2,
  });
  assert.equal(req.id, "req-1");
  assert.equal(req.isPending, true);
  assert.equal(req.isAuthorized, false);
  assert.equal(req.outcome, null);
  assert.equal(req.replayed, false);
  assert.equal(req.operationHash, "sha256:54feb247e0ae56c01d430beb1b1c4c604384ca91832a1ccb435fe2753fb2be9e");
  assert.equal(req.createdAt.getTime(), 1788350100000);
  assert.equal(req.decidedAt, null);
});

test("create without an idempotency key isn't retried", async () => {
  const { server, outis } = await setup(() => ({ status: 503, body: { error: "busy" } }));
  await assert.rejects(outis.requests.create(deploy), (err: unknown) => {
    assert.ok(err instanceof OutisApiError);
    assert.equal(err.status, 503);
    return true;
  });
  assert.equal(server.seen.length, 1);
});

test("create with an idempotency key sends it and retries a 5xx", async () => {
  const { server, clock, outis } = await setup((_r, n) =>
    n === 1 ? { status: 502, body: { error: "bad gateway" } } : { status: 202, body: envelope() },
  );
  const req = await outis.requests.create(deploy, { idempotencyKey: "wf-42" });
  assert.equal(req.id, "req-1");
  assert.equal(server.seen.length, 2);
  assert.equal(server.seen[1]!.headers["idempotency-key"], "wf-42");
  assert.equal(clock.sleeps.length, 1);
});

test("create reports an idempotent replay", async () => {
  const { outis } = await setup(() => ({
    status: 202,
    body: envelope(),
    headers: { "idempotent-replayed": "true" },
  }));
  const req = await outis.requests.create(deploy, { idempotencyKey: "wf-42" });
  assert.equal(req.replayed, true);
});

test("create surfaces an idempotency conflict with its kind", async () => {
  const { outis } = await setup(() => ({
    status: 409,
    body: { error: "idempotency key reused for a different operation", kind: "idempotency_conflict" },
  }));
  await assert.rejects(outis.requests.create(deploy, { idempotencyKey: "wf-42" }), (err: unknown) => {
    assert.ok(err instanceof IdempotencyConflictError);
    assert.equal(err.status, 409);
    assert.equal(err.kind, "idempotency_conflict");
    return true;
  });
});

test("create refuses a bad idempotency key before sending", async () => {
  const { server, outis } = await setup(() => ({ status: 202, body: envelope() }));
  await assert.rejects(outis.requests.create(deploy, { idempotencyKey: "" }), TypeError);
  await assert.rejects(outis.requests.create(deploy, { idempotencyKey: "é" }), TypeError);
  await assert.rejects(outis.requests.create(deploy, { idempotencyKey: "k".repeat(256) }), TypeError);
  assert.equal(server.seen.length, 0);
});

test("retrieve reads a decided request and retries a transient failure", async () => {
  const { server, outis } = await setup((_r, n) =>
    n === 1 ? { status: 429, headers: { "retry-after": "1" }, body: { error: "slow down" } } : { status: 200, body: envelope({ outcome: "authorized" }) },
  );
  const req = await outis.requests.retrieve("req-1");
  assert.equal(server.seen[1]!.method, "GET");
  assert.equal(server.seen[1]!.path, "/v1/requests/req-1");
  assert.equal(req.isAuthorized, true);
  assert.equal(req.isPending, false);
  assert.deepEqual(req.approvers, ["maya", "sam"]);
  assert.equal(req.decidedAt?.getTime(), 1788350400000);
});

test("retrieve carries the API's status and kind on a refusal", async () => {
  const { outis } = await setup(() => ({ status: 404, body: { error: "no such request", kind: "not_found" } }));
  await assert.rejects(outis.requests.retrieve("req-nope"), (err: unknown) => {
    assert.ok(err instanceof OutisApiError);
    assert.equal(err.status, 404);
    assert.equal(err.kind, "not_found");
    assert.equal(err.code, "not_found");
    assert.match(err.message, /no such request/);
    return true;
  });
});

test("an error body's kind wins over code, which is only a fallback", async () => {
  const both = await setup(() => ({ status: 400, body: { error: "bad", kind: "invalid", code: "other" } }));
  await assert.rejects(both.outis.requests.retrieve("r"), (err: unknown) => err instanceof OutisApiError && err.kind === "invalid");
  const legacy = await setup(() => ({ status: 400, body: { error: "bad", code: "invalid" } }));
  await assert.rejects(legacy.outis.requests.retrieve("r"), (err: unknown) => err instanceof OutisApiError && err.kind === "invalid");
});

test("waitFor polls with growing, capped backoff until the request is decided", async () => {
  const { clock, outis } = await setup((_r, n) => ({
    status: 200,
    body: n < 8 ? envelope() : envelope({ outcome: "denied" }),
  }));
  const req = await outis.requests.waitFor("req-1", { timeout: "5m" });
  assert.equal(req.outcome, "denied");
  assert.equal(clock.sleeps.length, 7);
  assert.ok(clock.sleeps[0]! >= 800 && clock.sleeps[0]! <= 1200, `first poll ${clock.sleeps[0]}`);
  for (let i = 1; i < clock.sleeps.length; i++) assert.ok(clock.sleeps[i]! <= 12_000);
  assert.ok(clock.sleeps[6]! > clock.sleeps[0]!);
});

test("waitFor throws WaitTimeoutError with the request id when time runs out", async () => {
  const { clock, outis } = await setup(() => ({ status: 200, body: envelope() }));
  const start = clock.now();
  await assert.rejects(outis.requests.waitFor("req-1", { timeout: "30s" }), (err: unknown) => {
    assert.ok(err instanceof WaitTimeoutError);
    assert.equal(err.requestId, "req-1");
    assert.equal(err.request.isPending, true);
    return true;
  });
  assert.equal(clock.now() - start, 30_000);
});

test("waitFor requires a timeout and caps it at 30 minutes", async () => {
  const { server, outis } = await setup(() => ({ status: 200, body: envelope() }));
  await assert.rejects(outis.requests.waitFor("req-1", {} as never), /timeout is required/);
  await assert.rejects(outis.requests.waitFor("req-1", { timeout: "31m" }), /30m cap/);
  await assert.rejects(outis.requests.waitFor("req-1", { timeout: 0 }), RangeError);
  assert.equal(server.seen.length, 0);
});

test("waitFor stops when its signal aborts", async () => {
  const { outis } = await setup(() => ({ status: 200, body: envelope() }));
  const ctl = new AbortController();
  ctl.abort(new Error("shutting down"));
  await assert.rejects(outis.requests.waitFor("req-1", { timeout: "1m", signal: ctl.signal }), /shutting down/);
});

test("assertAuthorized accepts the operation the operators saw", async () => {
  const { outis } = await setup(() => ({ status: 200, body: envelope({ outcome: "authorized" }) }));
  const req = await outis.requests.assertAuthorized("req-1", { action: deploy.action, params: deploy.params });
  assert.equal(req.id, "req-1");
});

test("assertAuthorized refuses a different operation", async () => {
  const { outis } = await setup(() => ({ status: 200, body: envelope({ outcome: "authorized" }) }));
  await assert.rejects(
    outis.requests.assertAuthorized("req-1", { action: deploy.action, params: { ...deploy.params, sha: "0000000" } }),
    (err: unknown) => {
      assert.ok(err instanceof OperationMismatchError);
      assert.equal(err.actual, "sha256:54feb247e0ae56c01d430beb1b1c4c604384ca91832a1ccb435fe2753fb2be9e");
      assert.notEqual(err.expected, err.actual);
      return true;
    },
  );
});

test("assertAuthorized refuses a live or refused request", async () => {
  const live = await setup(() => ({ status: 200, body: envelope() }));
  await assert.rejects(live.outis.requests.assertAuthorized("req-1", deploy), (err: unknown) => {
    assert.ok(err instanceof NotAuthorizedError);
    assert.equal(err.outcome, null);
    return true;
  });
  const denied = await setup(() => ({ status: 200, body: envelope({ outcome: "denied" }) }));
  await assert.rejects(denied.outis.requests.assertAuthorized("req-1", deploy), (err: unknown) => {
    assert.ok(err instanceof NotAuthorizedError);
    assert.equal(err.outcome, "denied");
    return true;
  });
});

test("the client needs an API key", () => {
  assert.throws(() => new Outis({ apiKey: "" }), TypeError);
});
