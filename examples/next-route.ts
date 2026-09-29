// app/api/outis/route.ts in a Next.js App Router project: the webhook that runs authorized intents.
// Env: OUTIS_API_KEY (read and execute), OUTIS_INTENT_KEYS, OUTIS_WEBHOOK_SECRET, STRIPE_SECRET_KEY.
import Stripe from "stripe";
import { Outis } from "@outis/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handle: ((request: Request) => Promise<Response>) | undefined;

// Built on the first request, so `next build` never needs the secrets.
function handler(): (request: Request) => Promise<Response> {
  if (!handle) {
    const outis = new Outis({ apiKey: process.env.OUTIS_API_KEY! });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const worker = outis.worker({ clients: { stripe: { client: stripe, idempotency: "stripe" } } });
    handle = worker.fetchHandler(process.env.OUTIS_WEBHOOK_SECRET!);
  }
  return handle;
}

export async function POST(request: Request): Promise<Response> {
  return handler()(request);
}
