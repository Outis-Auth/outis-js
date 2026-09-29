// Field names follow Stripe's API reference, checked against https://docs.stripe.com/api/transfers/create,
// https://docs.stripe.com/api/payouts/create, https://docs.stripe.com/api/refunds/create and
// https://docs.stripe.com/api/customers/delete. Only ids, amounts, enums and a capped description are shown.
// A call missing a field Stripe requires throws a TypeError before any request, so approvers never see half an operation.
import type { Duration } from "./duration.js";
import type { DeferTo, GuardMethodDeferOptions, GuardMethodWaitOptions } from "./guard.js";

type Show<A extends unknown[]> = (...args: A) => Record<string, string>;

/** The caller's half of a recipe: who asks, and one of `wait` or `deferTo`. `deferTo.call` is filled in. */
export type RecipeWaitOptions<A extends unknown[]> = Omit<GuardMethodWaitOptions<A>, "action" | "showApprovers">;
export type RecipeDeferOptions<A extends unknown[]> = Omit<GuardMethodDeferOptions<A>, "action" | "showApprovers" | "deferTo"> & {
  deferTo: { worker: string; call?: string; executeWithin?: Duration };
};

/** A vetted `guardMethod` option set for one library method. */
export interface Recipe<A extends unknown[]> {
  <B extends A = A>(options: RecipeWaitOptions<B>): GuardMethodWaitOptions<B>;
  <B extends A = A>(options: RecipeDeferOptions<B>): GuardMethodDeferOptions<B>;
  readonly action: string;
  /** The dotted method a worker calls for `deferTo`. */
  readonly call: string;
  readonly showApprovers: Show<A>;
}

function recipe<A extends unknown[]>(action: string, call: string, showApprovers: Show<A>): Recipe<A> {
  const make = (options: RecipeWaitOptions<A> | RecipeDeferOptions<A>) => {
    const { deferTo, ...rest } = options as Omit<RecipeWaitOptions<A>, "deferTo"> & { deferTo?: Partial<DeferTo> };
    return deferTo
      ? { ...rest, action, showApprovers, deferTo: { call, ...deferTo } }
      : { ...rest, action, showApprovers };
  };
  return Object.assign(make, { action, call, showApprovers }) as unknown as Recipe<A>;
}

const DESCRIPTION_MAX = 64;

function shown(fields: Record<string, string | number | boolean | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    const text = String(v);
    out[k] = k === "description" && text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 3)}...` : text;
  }
  return out;
}

function missing(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

function need(method: string, fields: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (missing(v)) throw new TypeError(`stripe ${method} needs ${k}`);
  }
}

/** The request options stripe-node takes last. Only the connected account is shown. */
export interface StripeRequestOptions {
  stripeAccount?: string;
}

export interface StripeTransferParams {
  amount?: number;
  currency?: string;
  destination?: string;
  source_transaction?: string;
  description?: string;
}

export interface StripePayoutParams {
  amount?: number;
  currency?: string;
  destination?: string;
  method?: string;
  source_type?: string;
  description?: string;
}

export interface StripeRefundParams {
  charge?: string;
  payment_intent?: string;
  amount?: number;
  reason?: string;
  reverse_transfer?: boolean;
  refund_application_fee?: boolean;
}

/** Recipes for stripe-node, by resource and method: `recipes.stripe.transfers.create({ ... })`. */
export const stripe = {
  transfers: {
    create: recipe("stripe.transfers.create", "transfers.create", (p?: StripeTransferParams, o?: StripeRequestOptions) => {
      need("transfers.create", { amount: p?.amount, currency: p?.currency, destination: p?.destination });
      return shown({
        amount: p?.amount,
        currency: p?.currency,
        destination: p?.destination,
        source_transaction: p?.source_transaction,
        description: p?.description,
        stripe_account: o?.stripeAccount,
      });
    }),
  },
  payouts: {
    create: recipe("stripe.payouts.create", "payouts.create", (p?: StripePayoutParams, o?: StripeRequestOptions) => {
      need("payouts.create", { amount: p?.amount, currency: p?.currency });
      return shown({
        amount: p?.amount,
        currency: p?.currency,
        destination: p?.destination,
        method: p?.method,
        source_type: p?.source_type,
        description: p?.description,
        stripe_account: o?.stripeAccount,
      });
    }),
  },
  refunds: {
    create: recipe("stripe.refunds.create", "refunds.create", (p?: StripeRefundParams, o?: StripeRequestOptions) => {
      if (missing(p?.charge) && missing(p?.payment_intent)) throw new TypeError("stripe refunds.create needs charge or payment_intent");
      return shown({
        charge: p?.charge,
        payment_intent: p?.payment_intent,
        // Stripe refunds whatever remains on the charge when amount is left out.
        amount: p?.amount ?? "full",
        reason: p?.reason,
        reverse_transfer: p?.reverse_transfer,
        refund_application_fee: p?.refund_application_fee,
        stripe_account: o?.stripeAccount,
      });
    }),
  },
  customers: {
    del: recipe("stripe.customers.delete", "customers.del", (id: string, _params?: unknown, o?: StripeRequestOptions) => {
      need("customers.delete", { customer: id });
      return shown({ customer: id, stripe_account: o?.stripeAccount });
    }),
  },
};

/** Vetted option sets for well-known libraries. */
export const recipes = { stripe };
