import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { Outis, verifyWebhook, WebhookVerificationError } from "../src/index.js";
import { wireRequest } from "./fake.js";

const secret = "whsec_current";
const now = 1_790_000_000_000;
const t = Math.floor(now / 1000);
const body = JSON.stringify({
  id: "evt_1",
  type: "request.authorized",
  created_at: "2026-09-21T12:00:00Z",
  org: "org_1",
  data: { request: wireRequest({ outcome: "authorized" }) },
});

function sign(key: string, ts: number, raw: string): string {
  return createHmac("sha256", key).update(`${ts}.${raw}`).digest("hex");
}

test("a good delivery verifies and parses", () => {
  const event = verifyWebhook(body, { "Outis-Signature": `t=${t},v1=${sign(secret, t, body)}` }, secret, { now });
  assert.equal(event.id, "evt_1");
  assert.equal(event.type, "request.authorized");
  assert.equal(event.org, "org_1");
  assert.equal(event.createdAt, "2026-09-21T12:00:00Z");
  assert.equal(event.data.request.isAuthorized, true);
  assert.equal(event.data.request.id, "req-1");
});

test("the client's webhooks.verify reads fetch Headers and byte bodies", () => {
  const outis = new Outis({ apiKey: "k" });
  const headers = new Headers({ "outis-signature": `t=${t},v1=${sign(secret, t, body)}` });
  const event = outis.webhooks.verify(new TextEncoder().encode(body), headers, secret, { now: new Date(now) });
  assert.equal(event.id, "evt_1");
});

test("a stale timestamp is refused", () => {
  const old = t - 301;
  assert.throws(
    () => verifyWebhook(body, { "outis-signature": `t=${old},v1=${sign(secret, old, body)}` }, secret, { now }),
    /tolerance/,
  );
  const ahead = t + 301;
  assert.throws(
    () => verifyWebhook(body, { "outis-signature": `t=${ahead},v1=${sign(secret, ahead, body)}` }, secret, { now }),
    WebhookVerificationError,
  );
});

test("a tampered body or wrong secret is refused", () => {
  const header = { "outis-signature": `t=${t},v1=${sign(secret, t, body)}` };
  assert.throws(() => verifyWebhook(body.replace("org_1", "org_2"), header, secret, { now }), /doesn't match/);
  assert.throws(() => verifyWebhook(body, header, "whsec_other", { now }), WebhookVerificationError);
  assert.throws(() => verifyWebhook(body, {}, secret, { now }), /no Outis-Signature/);
  assert.throws(() => verifyWebhook(body, { "outis-signature": `v1=${sign(secret, t, body)}` }, secret, { now }), /timestamp/);
});

test("a rotated secret verifies, from either side", () => {
  const both = `t=${t},v1=${sign("whsec_old", t, body)},v1=${sign("whsec_new", t, body)}`;
  assert.equal(verifyWebhook(body, { "outis-signature": both }, "whsec_new", { now }).id, "evt_1");
  assert.equal(verifyWebhook(body, { "outis-signature": both }, "whsec_old", { now }).id, "evt_1");
  const one = `t=${t},v1=${sign("whsec_new", t, body)}`;
  assert.equal(verifyWebhook(body, { "outis-signature": one }, ["whsec_old", "whsec_new"], { now }).id, "evt_1");
});
