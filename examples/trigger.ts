// A Trigger.dev v4 task that proposes a payout and waits on a token. The token's URL is the request's
// callbackUrl, so Outis's decision completes the wait directly, with no bridge.
// Env: OUTIS_API_KEY (propose, read, execute), OUTIS_INTENT_KEY, STRIPE_SECRET_KEY.
import { task, wait } from "@trigger.dev/sdk";
import Stripe from "stripe";
import { Outis } from "@outis/sdk";

const outis = new Outis({ apiKey: process.env.OUTIS_API_KEY! });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const worker = outis.worker({ clients: { stripe: { client: stripe, idempotency: "stripe" } } });

export const payout = task({
  id: "outis-payout",
  run: async (payload: { payoutId: string; amount: number; destination: string }) => {
    const token = await wait.createToken({ timeout: "7d", idempotencyKey: `outis-${payload.payoutId}` });
    const { requestId } = await outis.intents.propose(
      {
        action: "stripe.transfer",
        requester: "payouts",
        params: { amount: String(payload.amount), to: payload.destination },
        client: "stripe",
        method: "transfers.create",
        args: [{ amount: payload.amount, currency: "usd", destination: payload.destination }],
        callbackUrl: token.url,
      },
      { idempotencyKey: `trigger-${payload.payoutId}` },
    );

    // Anyone holding token.url can complete it, and Trigger.dev doesn't check Outis's signature. So the
    // body is only a wake-up: the claim asks Outis, and an early wake just waits again.
    await wait.forToken(token);
    let result = await worker.execute(requestId);
    while (result.status === "skipped" && result.reason === "not_authorized") {
      if (!(await outis.requests.retrieve(requestId)).isPending) break;
      await wait.for({ minutes: 5 });
      result = await worker.execute(requestId);
    }
    const { result: _result, ...summary } = result;
    return summary;
  },
});
