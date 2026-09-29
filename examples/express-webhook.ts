// One Express app on both sides: a route that asks for a payout, and the webhook that runs it once
// it's approved. Env: OUTIS_API_KEY (propose, read, execute), OUTIS_INTENT_KEY, OUTIS_WEBHOOK_SECRET,
// STRIPE_SECRET_KEY.
import express from "express";
import Stripe from "stripe";
import { Outis } from "@outis-auth/sdk";
import { recipes } from "@outis-auth/sdk/recipes";

const outis = new Outis({ apiKey: process.env.OUTIS_API_KEY!, requester: "payouts-api" });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const createTransfer = outis.guardMethod(
  stripe.transfers,
  "create",
  recipes.stripe.transfers.create({
    summary: (t) => `Transfer ${t.amount / 100} ${t.currency.toUpperCase()} to ${t.destination}`,
    idempotencyKey: (t) => `payout-${t.metadata?.payout_id}`,
    deferTo: { worker: "stripe", executeWithin: "7d" },
  }),
);

const worker = outis.worker({ clients: { stripe: { client: stripe, idempotency: "stripe" } } });

const app = express();

app.post("/payouts", express.json(), async (req, res) => {
  const deferred = await createTransfer({
    amount: Number(req.body.amount),
    currency: "usd",
    destination: String(req.body.destination),
    metadata: { payout_id: String(req.body.payoutId) },
  });
  res.status(202).json({ requestId: deferred.id });
});

// The raw body matters: the signature covers the exact bytes Outis sent.
app.post("/outis/webhook", express.raw({ type: "application/json" }), worker.handler(process.env.OUTIS_WEBHOOK_SECRET!));

app.listen(3000, () => console.log("listening on :3000"));
