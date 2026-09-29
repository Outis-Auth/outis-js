import { checkIdempotencyKey, type Outis } from "./client.js";
import { MAX_WAIT_MS, parseDuration, type Duration } from "./duration.js";
import { NotAuthorizedError } from "./errors.js";
import { encodeIntent, INTENT_PARAM } from "./intents.js";
import type { CreateRequestInput, OutisRequest } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

/** What every `guard` call names: the action, who asks, and what the approvers see. */
export interface GuardBase {
  /** The action name, ie `stripe.transfer`. Policy for it lives in Outis. */
  action: string;
  /** Who is asking. Defaults to the client's `requester` option. */
  requester?: string;
  /** Exactly what the approvers see on the device, and what the approval binds. Values must be strings. */
  showApprovers?: Record<string, string>;
  summary?: string;
  /** The same key and operation return the original request instead of opening a second one. */
  idempotencyKey?: string;
}

/** Wait here, at most 30 minutes, while the SDK polls on timers. */
export interface GuardWaitOptions extends GuardBase {
  wait: Duration;
  deferTo?: undefined;
  /** Stops local polling and rejects with the signal's reason. The request stays live in Outis. */
  signal?: AbortSignal;
}

/** The call a worker makes once the request is authorized. */
export interface DeferTo {
  /** The name the worker registered the client under, ie `stripe`. */
  worker: string;
  /** A dotted method on that client, ie `transfers.create`. */
  call: string;
  /** Plain JSON arguments. Default none. */
  args?: unknown[];
  /** How long after authorization the worker may still run it. Default 7 days, at most 30. */
  executeWithin?: Duration;
}

/** Seal the call and hand it to a worker. Nothing waits here and nothing runs. */
export interface GuardDeferOptions extends GuardBase {
  deferTo: DeferTo;
  wait?: undefined;
}

export type GuardOptions = GuardWaitOptions | GuardDeferOptions;

/** A request whose sealed call a worker runs once it's authorized. Store `id` to follow it. */
export interface Deferred {
  id: string;
  request: OutisRequest;
  intentDigest: string;
}

function waitMs(value: Duration): number {
  const ms = parseDuration(value);
  if (ms <= 0) throw new RangeError("wait must be greater than zero");
  if (ms > MAX_WAIT_MS) {
    throw new RangeError(`wait ${ms}ms is over the 30m cap. For approvals that can take longer, use deferTo with a worker`);
  }
  return ms;
}

function checkPath(o: { wait?: unknown; deferTo?: unknown } | undefined, what: string): "wait" | "deferTo" {
  if (!o || typeof o !== "object") throw new TypeError(`${what} needs options`);
  const hasWait = o.wait !== undefined;
  const hasDefer = o.deferTo !== undefined;
  if (hasWait && hasDefer) throw new TypeError(`${what} takes wait or deferTo, not both`);
  if (!hasWait && !hasDefer) {
    throw new TypeError(
      `${what} needs exactly one of wait (hold on here, up to 30m) or deferTo (a worker runs the call once it's approved)`,
    );
  }
  return hasWait ? "wait" : "deferTo";
}

function checkDeferTo(outis: Outis, d: DeferTo, needArgs: boolean): void {
  if (!d || typeof d !== "object") throw new TypeError("deferTo must be an object");
  if (typeof d.worker !== "string" || d.worker === "") throw new TypeError("deferTo.worker is required");
  if (typeof d.call !== "string" || d.call === "") throw new TypeError("deferTo.call is required");
  if (needArgs) encodeIntent({ client: d.worker, method: d.call, args: d.args ?? [] });
  if (d.executeWithin !== undefined) parseDuration(d.executeWithin);
  if (outis.intents.keys.length === 0) {
    throw new TypeError("deferTo needs an intent key: pass intentKey to new Outis() or set OUTIS_INTENT_KEY");
  }
}

function checkRequest(o: GuardBase, defaultRequester: string | undefined, deferred: boolean): CreateRequestInput {
  if (typeof o.action !== "string" || o.action === "") throw new TypeError("action is required");
  const requester = o.requester ?? defaultRequester;
  if (typeof requester !== "string" || requester === "") {
    throw new TypeError("requester is required: pass it here or set requester on new Outis()");
  }
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.showApprovers ?? {})) {
    if (typeof v !== "string") throw new TypeError(`showApprovers.${k} must be a string, got ${typeof v}`);
    params[k] = v;
  }
  if (deferred && Object.hasOwn(params, INTENT_PARAM)) {
    throw new TypeError(`showApprovers.${INTENT_PARAM} is reserved for the sealed call's digest`);
  }
  if (o.summary !== undefined && typeof o.summary !== "string") throw new TypeError("summary must be a string");
  if (o.idempotencyKey !== undefined) checkIdempotencyKey(o.idempotencyKey);
  return { action: o.action, requester, params, ...(o.summary !== undefined ? { summary: o.summary } : {}) };
}

/** @internal The body of `Outis.guard`. Every check runs before any request is sent. */
export async function guard(
  outis: Outis,
  defaultRequester: string | undefined,
  options: GuardOptions,
): Promise<OutisRequest | Deferred> {
  const path = checkPath(options, "guard");
  const input = checkRequest(options, defaultRequester, path === "deferTo");
  const create = options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};

  if (path === "deferTo") {
    const d = (options as GuardDeferOptions).deferTo;
    checkDeferTo(outis, d, true);
    const p = await outis.intents.propose(
      {
        ...input,
        client: d.worker,
        method: d.call,
        args: d.args ?? [],
        ...(d.executeWithin !== undefined ? { executeWithin: d.executeWithin } : {}),
      },
      create,
    );
    return { id: p.requestId, request: p.request, intentDigest: p.intentDigest };
  }

  const { wait, signal } = options as GuardWaitOptions;
  const timeout = waitMs(wait);
  signal?.throwIfAborted();
  const created = await outis.requests.create(input, create);
  let decided: OutisRequest = created;
  if (created.outcome === null) {
    decided = await outis.requests.waitFor(created.id, { timeout, ...(signal ? { signal } : {}) });
  }
  if (decided.outcome !== "authorized") throw new NotAuthorizedError(decided);
  return decided;
}

type Fn = (...args: any[]) => any;

/** The keys of `T` that hold methods. */
export type MethodKeys<T> = { [K in keyof T]-?: T[K] extends Fn ? K : never }[keyof T] & string;
/** The parameter list of a method type. */
export type ArgsOf<F> = F extends (...args: infer A) => any ? A : never;
type ResultOf<F> = F extends (...args: any[]) => infer R ? Awaited<R> : never;

/** A value, or a function of the guarded call's arguments that returns it. */
export type FromArgs<A extends unknown[], V> = V | ((...args: A) => MaybePromise<V>);

export interface GuardMethodBase<A extends unknown[]> {
  action: string;
  requester?: FromArgs<A, string>;
  showApprovers?: FromArgs<A, Record<string, string>>;
  summary?: FromArgs<A, string>;
  idempotencyKey?: FromArgs<A, string | undefined>;
}

/** Each call waits for approval, then runs the real method with the same arguments. */
export interface GuardMethodWaitOptions<A extends unknown[] = any[]> extends GuardMethodBase<A> {
  wait: Duration;
  deferTo?: undefined;
}

/** Each call is sealed with its own arguments and handed to a worker. The real method doesn't run here. */
export interface GuardMethodDeferOptions<A extends unknown[] = any[]> extends GuardMethodBase<A> {
  deferTo: Omit<DeferTo, "args">;
  wait?: undefined;
}

export type GuardMethodOptions<A extends unknown[] = any[]> = GuardMethodWaitOptions<A> | GuardMethodDeferOptions<A>;

/** A guarded method for the wait path: resolves with what the real method returns. */
export type GuardedWait<F> = (...args: ArgsOf<F>) => Promise<ResultOf<F>>;
/** A guarded method for the deferTo path: resolves with the Deferred handle. */
export type GuardedDefer<F> = (...args: ArgsOf<F>) => Promise<Deferred>;

async function fromArgs<A extends unknown[], V>(value: FromArgs<A, V> | undefined, args: A): Promise<V | undefined> {
  return typeof value === "function" ? await (value as (...a: A) => MaybePromise<V>)(...args) : value;
}

/** @internal The body of `Outis.guardMethod`. */
export function guardMethod(
  outis: Outis,
  target: object,
  method: string,
  options: GuardMethodOptions,
): (...args: unknown[]) => Promise<unknown> {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    throw new TypeError("guardMethod needs the object that owns the method");
  }
  const fn: unknown = Reflect.get(target, method);
  if (typeof fn !== "function") throw new TypeError(`guardMethod: ${method} isn't a method on the target`);
  const path = checkPath(options, "guardMethod");
  if (typeof options.action !== "string" || options.action === "") throw new TypeError("action is required");
  if (path === "wait") waitMs((options as GuardMethodWaitOptions).wait);
  else checkDeferTo(outis, { ...(options as GuardMethodDeferOptions).deferTo }, false);

  return async (...args: unknown[]) => {
    const common: GuardBase = { action: options.action };
    const requester = await fromArgs(options.requester, args);
    const showApprovers = await fromArgs(options.showApprovers, args);
    const summary = await fromArgs(options.summary, args);
    const idempotencyKey = await fromArgs(options.idempotencyKey, args);
    if (requester !== undefined) common.requester = requester;
    if (showApprovers !== undefined) common.showApprovers = showApprovers;
    if (summary !== undefined) common.summary = summary;
    if (idempotencyKey !== undefined) common.idempotencyKey = idempotencyKey;

    if (path === "deferTo") {
      return outis.guard({ ...common, deferTo: { ...(options as GuardMethodDeferOptions).deferTo, args } });
    }
    await outis.guard({ ...common, wait: (options as GuardMethodWaitOptions).wait });
    return Reflect.apply(fn as Fn, target, args);
  };
}

