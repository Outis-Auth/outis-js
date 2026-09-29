// An Inngest function (SDK v4) that asks for a payout, sleeps on step.waitForEvent until Outis decides,
// then runs it in a step. Outis's webhook lands on outisWebhook, which verifies it and sends the event.
// Serve both from your app, ie app/api/inngest/route.ts: export const { GET, POST, PUT } = serve({ client: inngest, functions: [payout] }).
// Env: OUTIS_API_KEY (propose, read, execute), OUTIS_INTENT_KEY, OUTIS_WEBHOOK_SECRET, STRIPE_SECRET_KEY.
import { Inngest } from "inngest";
import Stripe from "stripe";
import { Outis, WebhookVerificationError } from "@outis-auth/sdk";

export const inngest = new Inngest({ id: "payouts" });

const outis = new Outis({ apiKey: process.env.OUTIS_API_KEY! });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const worker = outis.worker({ clients: { stripe: { client: stripe, idempotency: "stripe" } } });

export const payout = inngest.createFunction(
  { id: "outis-payout", triggers: { event: "payouts/requested" } },
  async ({ event, step }) => {
    const { payoutId, amount, destination } = event.data as { payoutId: string; amount: number; destination: string };

    const requestId = await step.run("propose", async () => {
      const deferred = await outis.guard({
        action: "stripe.transfer",
        requester: "payouts",
        showApprovers: { amount: String(amount), to: destination },
        idempotencyKey: `inngest-${payoutId}`,
        deferTo: { worker: "stripe", call: "transfers.create", args: [{ amount, currency: "usd", destination }] },
      });
      return deferred.id;
    });

    await step.waitForEvent("outis-decision", {
      event: "outis/request.decided",
      timeout: "7d",
      if: `async.data.requestId == "${requestId}"`,
    });

    // The event is only a wake-up; the claim checks the decision with Outis and refuses anything unauthorized.
    return step.run("execute", async () => {
      const { result: _result, ...summary } = await worker.execute(requestId);
      return summary;
    });
  },
);

/** Mount at POST /outis/webhook. Inngest's own webhook transforms can't check an HMAC, so this does. */
export async function outisWebhook(request: Request): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  try {
    const event = outis.webhooks.verify(raw, request.headers, process.env.OUTIS_WEBHOOK_SECRET!);
    await inngest.send({ id: event.id, name: "outis/request.decided", data: { requestId: event.data.request.id, type: event.type } });
    return new Response(null, { status: 200 });
  } catch (err) {
    if (err instanceof WebhookVerificationError) return new Response(null, { status: 400 });
    throw err;
  }
}
