// Activities run in your Temporal worker, next to your credentials. The workflow never touches Outis directly.
import Stripe from "stripe";
import { Outis, type ExecutionResult } from "@outis/sdk";

const outis = new Outis({ apiKey: process.env.OUTIS_API_KEY! });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const worker = outis.worker({ clients: { stripe: { client: stripe, idempotency: "stripe" } } });

export interface Payout {
  payoutId: string;
  amount: number;
  destination: string;
}

/** Seals the transfer and asks for it. The key comes from the workflow id, so a retried activity finds the same request. */
export async function proposePayout(payout: Payout, workflowId: string): Promise<string> {
  const deferred = await outis.guard({
    action: "stripe.transfer",
    requester: "payouts-workflow",
    showApprovers: { amount: String(payout.amount), to: payout.destination, workflow_id: workflowId },
    idempotencyKey: `temporal-${workflowId}`,
    deferTo: {
      worker: "stripe",
      call: "transfers.create",
      args: [{ amount: payout.amount, currency: "usd", destination: payout.destination }],
    },
  });
  return deferred.id;
}

/** Claims, checks and runs the intent. A retry after it ran comes back skipped, never runs twice. */
export async function executeIntent(requestId: string): Promise<Omit<ExecutionResult, "result">> {
  const { result: _result, ...summary } = await worker.execute(requestId);
  return summary;
}
