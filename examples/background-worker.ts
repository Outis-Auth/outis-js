// A long running worker: polls Outis for approved calls and runs them with your own credentials.
// It stops cleanly on SIGTERM or SIGINT. Env: OUTIS_API_KEY (scopes read and execute), OUTIS_INTENT_KEYS,
// STRIPE_SECRET_KEY.
import Stripe from "stripe";
import { Outis } from "@outis/sdk";

const outis = new Outis({ apiKey: process.env.OUTIS_API_KEY! });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const worker = outis.worker({
  clients: {
    stripe: { client: stripe, idempotency: "stripe" },
  },
  handlers: {
    "db.restore": async (ctx, db: string, snapshot: string) => {
      console.log(`restoring ${db} from ${snapshot} for ${ctx.requestId}`);
      return { id: `restore_${snapshot}` };
    },
  },
  allow: ["stripe.transfers.create", "db.restore"],
  concurrency: 4,
  onResult: (r) => console.log(`${r.requestId} ${r.status}${r.reason ? ` (${r.reason})` : ""}`),
});

worker
  .start()
  .then(() => console.log("stopped"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
