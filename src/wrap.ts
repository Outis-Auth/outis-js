import type { Outis, PendingExecution } from "./client.js";
import { parseDuration, parseWaitTimeout, type Duration } from "./duration.js";
import { IntentVerificationError, NotAuthorizedError, OutisApiError, WaitTimeoutError } from "./errors.js";
import type { CreateRequestInput, OutisRequest } from "./types.js";
import { referenceOf, withIdempotencyKey, type IdempotencyStyle } from "./worker.js";

type MaybePromise<T> = T | Promise<T>;
type Args = any[];

/** How one wrapped method becomes a request. Every function gets the method's own arguments. */
export interface WrapMethod<A extends Args = Args> {
  /** The Outis action this method performs. */
  action: string;
  /** Return false to call the method directly, with no request at all. */
  when?: (...args: A) => MaybePromise<boolean>;
  /** What the operators see and approve. */
  params: (...args: A) => MaybePromise<Record<string, string>>;
  requester: string | ((...args: A) => MaybePromise<string>);
  summary?: (...args: A) => MaybePromise<string>;
  /** An idempotency key for the request, so a retried call can't open a second one. */
  idempotencyKey?: (...args: A) => MaybePromise<string | undefined>;
}

/** Methods to guard, by dotted path from the wrapped object, ie `"transfers.create"`. */
export type WrapMethods = Record<string, WrapMethod>;

interface DurableOptions {
  /** The name your worker registers this client under. */
  client: string;
  /** How long after authorization a worker may still claim the call. Default 7 days, at most 30. */
  executeWithin?: Duration;
  callbackUrl?: string;
}

/**
 * `wait` blocks each call on a bounded `guard`, then runs the real method.
 * `durable` seals the call as an intent, proposes it and resolves with a pending handle; a worker runs it later.
 * `hybrid` proposes the same way, waits up to `wait`, and runs the call itself if it's authorized in time.
 */
export type WrapOptions =
  | { mode: "wait"; timeout: Duration; signal?: AbortSignal }
  | ({ mode: "durable" } & DurableOptions)
  | ({
      mode: "hybrid";
      /** How long to wait before handing the call to a worker. At most 30 minutes. */
      wait: Duration;
      /** Pass the request id downstream as an idempotency key, the way this client takes one. */
      idempotency?: IdempotencyStyle;
      /** The claim's lease when this process runs the call itself. Default 600. */
      leaseSeconds?: number;
      signal?: AbortSignal;
    } & DurableOptions);

/** The call ran: here's what the real method returned. `request` is null when `when` skipped Outis. */
export interface Done<R> {
  status: "done";
  result: R;
  request: OutisRequest | null;
}

/** What a durable or hybrid wrapped method resolves with. */
export type Settled<R> = Done<R> | PendingExecution;

type Fn = (...args: Args) => unknown;
type Head<P extends string> = P extends `${infer H}.${string}` ? H : P;
type Tail<P extends string, H extends string> = P extends `${H}.${infer R}` ? R : never;

/**
 * `T` with the methods at the dotted paths `P` returning promises: of the result in `wait` mode,
 * of a Settled result in `durable` and `hybrid`.
 */
export type Guarded<T, P extends string, Mode extends WrapOptions["mode"] = "wait"> = {
  [K in keyof T]: K extends P
    ? T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Mode extends "wait" ? Awaited<R> : Settled<Awaited<R>>>
      : T[K]
    : K extends Head<P>
      ? Guarded<T[K], Tail<P, K>, Mode>
      : T[K];
};

function isFixed(obj: object, prop: PropertyKey): boolean {
  const d = Reflect.getOwnPropertyDescriptor(obj, prop);
  return !!d && d.configurable === false && d.writable === false;
}

export function wrap<T extends object, M extends WrapMethods, O extends WrapOptions>(
  outis: Outis,
  target: T,
  methods: M,
  options: O,
): Guarded<T, keyof M & string, O["mode"]> {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    throw new TypeError("wrap needs an object to wrap");
  }
  const opts = options as WrapOptions;
  if (!opts || (opts.mode !== "wait" && opts.mode !== "durable" && opts.mode !== "hybrid")) {
    throw new TypeError('wrap needs options.mode: "wait", "durable" or "hybrid"');
  }
  const timeoutMs = opts.mode === "wait" ? parseWaitTimeout(opts.timeout) : opts.mode === "hybrid" ? parseWaitTimeout(opts.wait) : 0;
  if (opts.mode !== "wait") {
    if (typeof opts.client !== "string" || opts.client === "") {
      throw new TypeError(`wrap in ${opts.mode} mode needs options.client, the name your worker registers it under`);
    }
    if (opts.executeWithin !== undefined) parseDuration(opts.executeWithin);
    if (outis.intents.keys.length === 0) {
      throw new TypeError(`wrap in ${opts.mode} mode needs an intent key: pass intentKey to new Outis() or set OUTIS_INTENT_KEY`);
    }
  }

  const prefixes = new Set<string>();
  for (const [path, cfg] of Object.entries(methods)) {
    if (!cfg || typeof cfg.action !== "string" || typeof cfg.params !== "function") {
      throw new TypeError(`wrap: "${path}" needs an action and a params function`);
    }
    let obj: unknown = target;
    const parts = path.split(".");
    parts.forEach((part, i) => {
      if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) {
        throw new TypeError(`wrap: "${path}" doesn't resolve on the target`);
      }
      if (isFixed(obj as object, part)) {
        throw new TypeError(`wrap: "${path}" runs through a frozen property and can't be wrapped`);
      }
      obj = Reflect.get(obj as object, part);
      if (i < parts.length - 1) prefixes.add(parts.slice(0, i + 1).join("."));
    });
    if (typeof obj !== "function") throw new TypeError(`wrap: "${path}" isn't a method on the target`);
  }

  async function gate(path: string, fn: Fn, self: object, args: Args): Promise<unknown> {
    const cfg = methods[path]!;
    const skip = cfg.when && !(await cfg.when(...args));
    if (skip) {
      const result = await Reflect.apply(fn, self, args);
      return opts.mode === "wait" ? result : { status: "done", result, request: null };
    }
    const params = await cfg.params(...args);
    const requester = typeof cfg.requester === "function" ? await cfg.requester(...args) : cfg.requester;
    const summary = cfg.summary ? await cfg.summary(...args) : undefined;
    const idempotencyKey = cfg.idempotencyKey ? await cfg.idempotencyKey(...args) : undefined;
    const input: CreateRequestInput = { action: cfg.action, requester, params };
    if (summary !== undefined) input.summary = summary;

    if (opts.mode === "wait") {
      await outis.guard({
        action: input.action,
        requester: input.requester,
        showApprovers: params,
        ...(summary !== undefined ? { summary } : {}),
        wait: timeoutMs,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return await Reflect.apply(fn, self, args);
    }

    const pending = await outis.intents.propose(
      {
        ...input,
        client: opts.client,
        method: path,
        args,
        ...(opts.executeWithin !== undefined ? { executeWithin: opts.executeWithin } : {}),
        ...(opts.callbackUrl !== undefined ? { callbackUrl: opts.callbackUrl } : {}),
      },
      idempotencyKey !== undefined ? { idempotencyKey } : {},
    );
    if (opts.mode === "durable") return pending;
    return runIfAuthorizedInTime(pending, fn, self, args);
  }

  async function runIfAuthorizedInTime(pending: PendingExecution, fn: Fn, self: object, args: Args): Promise<unknown> {
    if (opts.mode !== "hybrid") return pending;
    const signal = opts.signal;
    let decided: OutisRequest;
    try {
      decided = await outis.requests.waitFor(pending.requestId, { timeout: timeoutMs, ...(signal ? { signal } : {}) });
    } catch (err) {
      if (err instanceof WaitTimeoutError) return { ...pending, request: err.request };
      throw err;
    }
    if (decided.outcome !== "authorized") throw new NotAuthorizedError(decided);

    let claim;
    try {
      claim = await outis.requests.claim(pending.requestId, {
        ...(opts.leaseSeconds !== undefined ? { leaseSeconds: opts.leaseSeconds } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // Another process holds or finished the run; the worker side owns it now.
      if (err instanceof OutisApiError && (err.status === 409 || err.status === 410)) return { ...pending, request: decided };
      throw err;
    }
    // A report that can't land lets the lease lapse; the caller still gets the original error.
    const fail = (error: string) =>
      outis.requests
        .reportExecution(pending.requestId, { claimId: claim.claimId, status: "failed", error })
        .catch(() => undefined);
    try {
      outis.intents.open(claim.request);
    } catch (err) {
      const reason = err instanceof IntentVerificationError ? err.reason : "bad_intent";
      await fail(`${reason}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    const callArgs = opts.idempotency ? withIdempotencyKey(args, pending.requestId, opts.idempotency) : args;
    let result: unknown;
    try {
      result = await Reflect.apply(fn, self, callArgs);
    } catch (err) {
      await fail(`execution_error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    const reference = referenceOf(result);
    await outis.requests.reportExecution(pending.requestId, {
      claimId: claim.claimId,
      status: "succeeded",
      ...(reference !== undefined ? { reference } : {}),
    });
    return { status: "done", result, request: claim.request };
  }

  const proxies = new Map<string, WeakMap<object, object>>();

  function proxyAt(obj: object, prefix: string): object {
    let cache = proxies.get(prefix);
    if (!cache) proxies.set(prefix, (cache = new WeakMap()));
    const hit = cache.get(obj);
    if (hit) return hit;

    const gatedByPath = new Map<string, { fn: Fn; proxy: Fn }>();
    const passed = new WeakMap<Fn, Fn>();
    const proxy: object = new Proxy(obj, {
      get(o, prop) {
        const value: unknown = Reflect.get(o, prop, o);
        if (isFixed(o, prop)) return value;
        const path = typeof prop === "string" ? (prefix ? `${prefix}.${prop}` : prop) : undefined;
        if (path !== undefined && Object.hasOwn(methods, path) && typeof value === "function") {
          const hit = gatedByPath.get(path);
          if (hit && hit.fn === value) return hit.proxy;
          const gated = new Proxy(value as Fn, {
            apply: (fn, thisArg, args) => gate(path, fn, thisArg === proxy ? o : thisArg, args),
          });
          gatedByPath.set(path, { fn: value as Fn, proxy: gated });
          return gated;
        }
        if (path !== undefined && prefixes.has(path) && value !== null && (typeof value === "object" || typeof value === "function")) {
          return proxyAt(value as object, path);
        }
        if (typeof value === "function") {
          let through = passed.get(value as Fn);
          if (!through) {
            // The real object stays `this`, so private fields and internal calls work as if unwrapped.
            through = new Proxy(value as Fn, {
              apply: (fn, thisArg, args) => Reflect.apply(fn, thisArg === proxy ? o : thisArg, args),
            });
            passed.set(value as Fn, through);
          }
          return through;
        }
        return value;
      },
      set(o, prop, value) {
        return Reflect.set(o, prop, value, o);
      },
    });
    cache.set(obj, proxy);
    return proxy;
  }

  return proxyAt(target, "") as Guarded<T, keyof M & string, O["mode"]>;
}
