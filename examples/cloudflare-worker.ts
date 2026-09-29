// A Cloudflare Worker that runs authorized intents from the webhook, with a cron trigger as the backstop.
// wrangler.toml needs compatibility_flags = ["nodejs_compat"] (the SDK uses node:crypto) and
// [triggers] crons = ["*/5 * * * *"]. Secrets: OUTIS_API_KEY, OUTIS_INTENT_KEYS, OUTIS_WEBHOOK_SECRET, STRIPE_SECRET_KEY.
import Stripe from "stripe";
import { Outis } from "@outis-auth/sdk";

interface Env {
  OUTIS_API_KEY: string;
  OUTIS_INTENT_KEYS: string;
  OUTIS_WEBHOOK_SECRET: string;
  STRIPE_SECRET_KEY: string;
}

interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

function worker(env: Env) {
  const outis = new Outis({ apiKey: env.OUTIS_API_KEY, intentKey: env.OUTIS_INTENT_KEYS.split(",") });
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  return outis.worker({ clients: { stripe: { client: stripe, idempotency: "stripe" } } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/outis/webhook") return new Response("not found", { status: 404 });
    return worker(env).fetchHandler(env.OUTIS_WEBHOOK_SECRET)(request);
  },

  async scheduled(_controller: unknown, env: Env, ctx: Context): Promise<void> {
    ctx.waitUntil(worker(env).poll());
  },
};
