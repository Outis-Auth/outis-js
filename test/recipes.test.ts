import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { stripe } from "../src/recipes.js";

/**
 * The Stripe recipe inputs every Outis SDK reproduces. A case missing a field Stripe requires carries
 * `error`, the missing field, and every SDK refuses it with "stripe <method> needs <error>". Run `npm run vectors` to rewrite
 * recipe-vectors.json from these after a recipe changes, then copy it into the other SDKs.
 */
interface RecipeInput {
  name: string;
  action: string;
  params?: Record<string, unknown>;
  customer?: string;
  options: { stripe_account?: string };
}

const LONG =
  "September payout for the northwest region, weeks one through four, including the adjustment";
const EXACT = "Sixty-four characters exactly, no more and no less, for the cap.";

const inputs: RecipeInput[] = [
  {
    name: "transfer, required fields only, extras dropped",
    action: "stripe.transfers.create",
    params: { amount: 2500000, currency: "usd", destination: "acct_9f2", transfer_group: "ORDER_95", metadata: { email: "jenny@example.com" } },
    options: {},
  },
  {
    name: "transfer, every field on a connected account",
    action: "stripe.transfers.create",
    params: { amount: 400, currency: "eur", destination: "acct_1", source_transaction: "ch_3Mt", description: "June sales" },
    options: { stripe_account: "acct_1Nv0" },
  },
  {
    name: "transfer, long description cut",
    action: "stripe.transfers.create",
    params: { amount: 400, currency: "usd", destination: "acct_1", description: LONG },
    options: {},
  },
  {
    name: "transfer, description at the cap kept whole",
    action: "stripe.transfers.create",
    params: { amount: 400, currency: "usd", destination: "acct_1", description: EXACT },
    options: {},
  },
  {
    name: "payout, no destination or method invented",
    action: "stripe.payouts.create",
    params: { amount: 1100, currency: "usd", description: null },
    options: {},
  },
  {
    name: "payout, every field on a connected account",
    action: "stripe.payouts.create",
    params: {
      amount: 5000,
      currency: "eur",
      destination: "ba_1MtIhL2eZvKYlo2C",
      method: "instant",
      source_type: "card",
      description: "Weekly",
      statement_descriptor: "ACME",
    },
    options: { stripe_account: "acct_1Nv0" },
  },
  {
    name: "payout, accented long description cut",
    action: "stripe.payouts.create",
    params: { amount: 700, currency: "usd", method: "standard", description: `Café ${LONG}` },
    options: {},
  },
  {
    name: "refund, no amount means full",
    action: "stripe.refunds.create",
    params: { charge: "ch_1NirD82eZvKYlo2C", instructions_email: "jenny@example.com" },
    options: {},
  },
  {
    name: "refund, every field on a connected account",
    action: "stripe.refunds.create",
    params: {
      payment_intent: "pi_1Gsz",
      amount: 1000,
      reason: "duplicate",
      reverse_transfer: true,
      refund_application_fee: false,
      metadata: { order: "95" },
    },
    options: { stripe_account: "acct_1Nv0" },
  },
  {
    name: "refund, charge with a partial amount and empty reason",
    action: "stripe.refunds.create",
    params: { charge: "ch_1Nir", amount: 250, reason: "" },
    options: {},
  },
  {
    name: "customer delete",
    action: "stripe.customers.delete",
    customer: "cus_NffrFeUfNV2Hib",
    options: {},
  },
  {
    name: "customer delete on a connected account",
    action: "stripe.customers.delete",
    customer: "cus_NffrFeUfNV2Hib",
    options: { stripe_account: "acct_1Nv0" },
  },
  {
    name: "transfer without destination refused",
    action: "stripe.transfers.create",
    params: { amount: 400, currency: "usd", description: "June sales" },
    options: {},
  },
  {
    name: "transfer without amount refused on a connected account",
    action: "stripe.transfers.create",
    params: { currency: "usd", destination: "acct_1" },
    options: { stripe_account: "acct_1Nv0" },
  },
  {
    name: "transfer with empty currency refused",
    action: "stripe.transfers.create",
    params: { amount: 400, currency: "", destination: "acct_1" },
    options: {},
  },
  {
    name: "payout without currency refused",
    action: "stripe.payouts.create",
    params: { amount: 1100, method: "instant" },
    options: {},
  },
  {
    name: "payout with null amount refused",
    action: "stripe.payouts.create",
    params: { amount: null, currency: "usd" },
    options: {},
  },
  {
    name: "refund without charge or payment intent refused",
    action: "stripe.refunds.create",
    params: { amount: 1000, reason: "duplicate" },
    options: {},
  },
  {
    name: "refund with empty charge and null payment intent refused",
    action: "stripe.refunds.create",
    params: { charge: "", payment_intent: null },
    options: {},
  },
  {
    name: "customer delete without an id refused",
    action: "stripe.customers.delete",
    customer: "",
    options: {},
  },
];

type Loose = (...args: unknown[]) => Record<string, string>;

function show(input: RecipeInput): Record<string, string> {
  const o = { stripeAccount: input.options.stripe_account };
  switch (input.action) {
    case "stripe.transfers.create":
      return (stripe.transfers.create.showApprovers as Loose)(input.params, o);
    case "stripe.payouts.create":
      return (stripe.payouts.create.showApprovers as Loose)(input.params, o);
    case "stripe.refunds.create":
      return (stripe.refunds.create.showApprovers as Loose)(input.params, o);
    case "stripe.customers.delete":
      return stripe.customers.del.showApprovers(input.customer!, undefined, o);
    default:
      throw new Error(`no recipe for ${input.action}`);
  }
}

const REFUSAL = /^stripe \S+ needs (.+)$/;

function outcome(input: RecipeInput): { shown: Record<string, string> } | { error: string } {
  try {
    return { shown: show(input) };
  } catch (err) {
    const message = err instanceof TypeError ? err.message : "";
    const m = REFUSAL.exec(message);
    if (!m) throw err;
    assert.equal(message, `stripe ${input.action.slice("stripe.".length)} needs ${m[1]}`);
    return { error: m[1]! };
  }
}

function generate(): string {
  const cases = inputs.map((input) => ({ ...input, ...outcome(input) }));
  return `${JSON.stringify({ description_max: 64, cases }, null, 2)}\n`;
}

const file = new URL("../../recipe-vectors.json", import.meta.url);

test("recipe-vectors.json is what the recipes show", () => {
  if (process.env.OUTIS_WRITE_RECIPE_VECTORS) writeFileSync(file, generate());
  assert.equal(readFileSync(file, "utf8"), generate());
});

test("the vectors cover the edges every SDK must match", () => {
  const cases = JSON.parse(generate()).cases as { shown?: Record<string, string>; error?: string }[];
  const values = cases.flatMap((c) => Object.entries(c.shown ?? {}));
  const errors = cases.map((c) => c.error);
  for (const field of ["amount", "currency", "destination", "charge or payment_intent", "customer"]) {
    assert.ok(errors.includes(field), `no refusal for ${field}`);
  }
  assert.ok(values.some(([k, v]) => k === "description" && v.length === 64 && v.endsWith("...")));
  assert.ok(values.some(([k, v]) => k === "description" && v === EXACT));
  assert.ok(values.some(([k, v]) => k === "amount" && v === "full"));
  assert.ok(values.some(([k, v]) => k === "reverse_transfer" && v === "true"));
  assert.ok(values.some(([k, v]) => k === "refund_application_fee" && v === "false"));
  assert.ok(values.some(([k]) => k === "stripe_account"));
  assert.ok(!values.some(([k]) => k === "metadata" || k === "statement_descriptor" || k === "instructions_email"));
});
