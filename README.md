![Outis TypeScript SDK](assets/header.png)

The Outis TypeScript SDK lets your code ask people for approval before it does something risky.

## How Outis works

1. Your code asks Outis to approve an operation, like a large payout.
2. Outis shows the details to the right people on a physical device.
3. They approve it by hand, or they don't.
4. Your code learns the answer and runs the operation itself.

Outis never runs the operation, and it never sees your secrets, API keys or other credentials. It decides whether the right people approved, and keeps a record of who did.

## Install

```sh
npm install @outis/sdk
```

It needs Node 20 or newer. You'll also need an Outis API key, passed to the client as `apiKey`.

## Quickstart

```ts
import { Outis } from "@outis/sdk";

const outis = new Outis({ apiKey: process.env.OUTIS_API_KEY!, requester: "payouts-api" });

await outis.guard({
  action: "stripe.transfer",
  showApprovers: { amount: "2500000", currency: "usd", to: "acct_9f2" },
  wait: "5m",
});
await releasePayout(); // only runs once people approve
```

Approvers see `showApprovers` on the device, and their approval covers exactly those values. Every value has to be a string.

`guard` returns a normal promise. It polls on timers, so the rest of your process keeps working while it waits. To move on without awaiting it, chain it:

```ts
outis
  .guard({ action: "stripe.transfer", showApprovers: { amount: "2500000" }, wait: "5m" })
  .then(() => releasePayout())
  .catch((err) => console.error("payout not approved", err));
```

Always add a `.catch` to a `guard` you don't await, or a denial becomes an unhandled rejection.

## Pick a path

| Your situation | Use |
| - | - |
| People usually answer within minutes | `guard` with `wait` |
| The answer could take hours or days | `guard` with `deferTo`, plus a worker |
| You want to guard a method you already call | `guardMethod` |
| That method is on Stripe | `recipes.stripe` |

Every `guard` call takes exactly one of `wait` or `deferTo`. Passing neither or both rejects the promise before any request is sent.

## Waiting: `wait`

`wait` is how long this process will wait for an answer, up to 30 minutes. The promise resolves with the approved request, or rejects if the answer is no or time runs out (see [Errors](#errors)).

To stop waiting early, pass an `AbortSignal` as `signal`. Polling stops, but the request stays open in Outis.

The wait lives in your process. If the process exits first, the code after it never runs. Use `deferTo` for anything that has to survive a restart.

## Handing off: `deferTo` and a worker

With `deferTo`, the SDK encrypts the exact call (method and arguments) with your intent key and sends it with the request. The promise resolves as soon as the request exists, with a handle holding its `id`. The call runs later, in a worker.

```ts
const deferred = await outis.guard({
  action: "stripe.transfer",
  showApprovers: { amount: "2500000", currency: "usd", to: "acct_9f2" },
  deferTo: {
    worker: "stripe",
    call: "transfers.create",
    args: [{ amount: 2500000, currency: "usd", destination: "acct_9f2" }],
  },
});
console.log(deferred.id);
```

Generate an intent key with `openssl rand -base64 32` and set it as `OUTIS_INTENT_KEY` wherever you call `guard` and wherever the worker runs. Outis can't read the call.

The worker runs the call after people approve it, using your own Stripe client:

```ts
const worker = outis.worker({
  clients: { stripe: { client: stripe, idempotency: "stripe" } },
});
await worker.start(); // polls, and on SIGTERM or SIGINT it finishes current runs and stops
```

`deferTo.worker` names a key under `clients`, here `stripe`. For a starter worker on Next.js, Cloudflare, Temporal, Inngest or Trigger.dev, run `npx @outis/sdk init worker -runtime next` (or the runtime you use).

When no client covers the call, add a handler under `handlers`. It gets the context first, then the call's arguments:

```ts
const worker = outis.worker({
  handlers: {
    "db.restore": (ctx, db: string, snapshot: string) => restore(db, snapshot, ctx.idempotencyKey),
  },
});
```

On a cron trigger or a serverless function, where nothing stays running, `await worker.poll()` does one pass instead: it runs whatever's approved, waits for it, and resolves with the results.

## Guarding a method: `guardMethod`

`guardMethod` wraps one method you already call. The new function takes the same arguments, and its options can use them:

```ts
const createTransfer = outis.guardMethod(stripe.transfers, "create", {
  action: "stripe.transfer",
  showApprovers: (t) => ({ amount: String(t.amount), currency: t.currency, to: t.destination }),
  wait: "5m",
});

const transfer = await createTransfer({ amount: 2500000, currency: "usd", destination: "acct_9f2" });
```

With `wait`, the real method runs after approval and you get its result. With `deferTo: { worker: "stripe", call: "transfers.create" }`, the arguments go to the worker instead and you get the handle.

## Recipes

Recipes are ready-made `guardMethod` options for popular libraries. The Stripe recipes show approvers amounts (in the smallest currency unit), the currency, account and object ids, and a short description. They never show metadata, emails or card data.

```ts
import { recipes } from "@outis/sdk/recipes";

const createTransfer = outis.guardMethod(
  stripe.transfers,
  "create",
  recipes.stripe.transfers.create({ wait: "5m" }),
);
```

They cover `transfers.create`, `payouts.create`, `refunds.create` and `customers.del`. You still pick `wait` or `deferTo`; with `deferTo: { worker: "stripe" }` the recipe fills in `call`.

## Errors

| Error | When |
| - | - |
| `NotAuthorizedError` | People said no. `err.outcome` is `denied`, `expired` or `aborted`. |
| `WaitTimeoutError` | `wait` ran out. The request is still open, and `err.requestId` lets you check it later. |
| `OutisApiError` | The API refused a call. `err.status` and `err.kind` say why. |
| `OutisConnectionError` | The API couldn't be reached. |
| `TypeError`, `RangeError` | The options are wrong, for example both `wait` and `deferTo`. Nothing was sent. |

```ts
import { NotAuthorizedError, WaitTimeoutError } from "@outis/sdk";

try {
  await outis.guard({ action: "db.restore", showApprovers: { db: "payments" }, wait: "10m" });
} catch (err) {
  if (err instanceof NotAuthorizedError) console.log(`not approved: ${err.outcome}`);
  else if (err instanceof WaitTimeoutError) console.log(`still waiting: ${err.requestId}`);
  else throw err;
}
```

## Learn more

The [developer center](https://developers.outis.tech) has the rest:

- [SDK reference](https://developers.outis.tech/guides/sdks/), with every option and the lower-level calls (`requests.create`, `waitFor`, `assertAuthorized`, intents, claims and `wrap`)
- [Webhooks](https://developers.outis.tech/guides/webhooks/), to hear about decisions as they happen
- [Durable execution](https://developers.outis.tech/guides/durable-execution/), on `deferTo` and workers in depth
- [Engines](https://developers.outis.tech/guides/engines/), for Temporal, Inngest and Trigger.dev
- [HTTP API reference](https://developers.outis.tech/api/), for calling Outis without an SDK
