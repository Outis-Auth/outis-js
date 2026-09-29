import type { IncomingMessage, ServerResponse } from "node:http";
import type { Claim, Outis } from "./client.js";
import { systemClock, type Clock } from "./clock.js";
import { parseDuration, type Duration } from "./duration.js";
import { IntentVerificationError, OutisApiError, WebhookVerificationError } from "./errors.js";
import type { OpenedIntent } from "./intents.js";
import type { OutisRequest } from "./types.js";
import { verifyWebhook, type HeaderSource, type WebhookSecret } from "./webhooks.js";

/** How a client takes an idempotency key. `stripe`: a trailing `{ idempotencyKey }` options object. */
export type IdempotencyStyle = "stripe";

/** A client with options, for `clients` entries that need more than the bare object. */
export interface ClientRegistration {
  client: object;
  /** Pass the request id downstream as the client's idempotency key. */
  idempotency?: IdempotencyStyle;
}

/** What a handler, or `onResult`, learns about the run. */
export interface ExecutionContext {
  requestId: string;
  /** The request id, to hand downstream so a rerun after a crash can't act twice. */
  idempotencyKey: string;
  claimId: string;
  request: OutisRequest;
  client: string;
  method: string;
}

/** Runs one `client.method` itself, for anything a registered client can't express. */
export type IntentHandler = (ctx: ExecutionContext, ...args: any[]) => unknown;

/** How one request's run went. `skipped` means this worker didn't run it (claimed elsewhere, not due). */
export interface ExecutionResult {
  requestId: string;
  status: "succeeded" | "failed" | "skipped";
  /** Why it failed or was skipped: a check's reason code, `execution_error`, or the API's error kind. */
  reason?: string;
  client?: string;
  method?: string;
  /** What the call returned. */
  result?: unknown;
  reference?: string;
  error?: string;
  /** False when the run finished but Outis couldn't be told; the lease then lapses and it's retried. */
  reported?: boolean;
}

export interface WorkerOptions {
  /** Clients by the name proposers use, ie `{ stripe }` or `{ stripe: { client: stripe, idempotency: "stripe" } }`. */
  clients?: Record<string, object | ClientRegistration>;
  /** Handlers by `client.method`, checked before `clients`. They get the context first, then the args. */
  handlers?: Record<string, IntentHandler>;
  /** Only run calls matching one of these, ie `"stripe.transfers.*"`. `*` matches anything. */
  allow?: readonly string[];
  /** How many runs at once. Default 4. */
  concurrency?: number;
  /** Seconds a claim holds before another worker may take it. Default 600. */
  leaseSeconds?: number;
  onResult?: (result: ExecutionResult, ctx: ExecutionContext | null) => void | Promise<void>;
  /** Errors the worker recovered from: a failed poll, a throwing onResult. Defaults to console.error. */
  onError?: (err: unknown) => void;
  clock?: Clock;
}

const STRIPE_OPTION_KEYS = [
  "apiKey",
  "idempotencyKey",
  "stripeAccount",
  "stripeContext",
  "apiVersion",
  "maxNetworkRetries",
  "timeout",
  "host",
  "authenticator",
  "additionalHeaders",
  "streaming",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Adds `key` to a call's arguments the way the client takes one. For `stripe`: merged into a trailing
 * options object, or appended as one when there isn't any. A key the caller set wins.
 */
export function withIdempotencyKey(args: readonly unknown[], key: string, style: IdempotencyStyle): unknown[] {
  if (style !== "stripe") return [...args];
  const last = args[args.length - 1];
  if (isPlainObject(last) && STRIPE_OPTION_KEYS.some((k) => Object.hasOwn(last, k))) {
    if (last.idempotencyKey !== undefined) return [...args];
    return [...args.slice(0, -1), { ...last, idempotencyKey: key }];
  }
  return [...args, { idempotencyKey: key }];
}

/** The reference a run reports: the result's `id` when it has a string one. */
export function referenceOf(result: unknown): string | undefined {
  const id = result !== null && typeof result === "object" ? (result as { id?: unknown }).id : undefined;
  return typeof id === "string" && id !== "" ? id : undefined;
}

const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);

function resolveMethod(target: object, path: string): { self: object; fn: (...a: unknown[]) => unknown } | undefined {
  let self: unknown = undefined;
  let value: unknown = target;
  for (const part of path.split(".")) {
    if (part === "" || BLOCKED.has(part) || part in Object.prototype || part in Function.prototype) return undefined;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
    self = value;
    value = Reflect.get(value as object, part);
  }
  if (typeof value !== "function" || self === undefined) return undefined;
  return { self: self as object, fn: value as (...a: unknown[]) => unknown };
}

function pattern(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readNodeBody(req: IncomingMessage & { body?: unknown }): Promise<Uint8Array | string> {
  const pre = req.body;
  if (typeof pre === "string" || pre instanceof Uint8Array) return pre;
  if (pre !== undefined && pre !== null && typeof pre === "object" && Object.keys(pre).length > 0) {
    throw new TypeError("the body was already parsed; mount the handler with express.raw({ type: \"application/json\" })");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

/**
 * Claims authorized intents, opens and checks them, and runs them against the clients you registered,
 * with your credentials. Outis never sees the arguments; it only learns succeeded or failed.
 */
export class Worker {
  readonly #outis: Outis;
  readonly #clients: Map<string, ClientRegistration>;
  readonly #handlers: Map<string, IntentHandler>;
  readonly #allow: RegExp[] | undefined;
  readonly #concurrency: number;
  readonly #lease: number;
  readonly #clock: Clock;
  readonly #onResult: WorkerOptions["onResult"];
  readonly #onError: (err: unknown) => void;
  readonly #inFlight = new Set<string>();

  constructor(outis: Outis, options: WorkerOptions) {
    this.#outis = outis;
    this.#clients = new Map();
    for (const [name, entry] of Object.entries(options?.clients ?? {})) {
      const isRegistration =
        isPlainObject(entry) && "client" in entry && Object.keys(entry).every((k) => k === "client" || k === "idempotency");
      this.#clients.set(name, isRegistration ? (entry as unknown as ClientRegistration) : { client: entry });
    }
    this.#handlers = new Map(Object.entries(options?.handlers ?? {}));
    if (this.#clients.size === 0 && this.#handlers.size === 0) {
      throw new TypeError("a worker needs at least one client or handler");
    }
    if (outis.intents.keys.length === 0) {
      throw new TypeError("a worker needs intent keys: pass intentKey to new Outis() or set OUTIS_INTENT_KEYS");
    }
    this.#allow = options.allow ? options.allow.map(pattern) : undefined;
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    this.#lease = options.leaseSeconds ?? 600;
    this.#clock = options.clock ?? systemClock;
    this.#onResult = options.onResult;
    this.#onError = options.onError ?? ((err) => console.error("outis worker:", err));
  }

  /**
   * Claims and runs one request. Resolves with what happened, including a skip when another worker
   * holds it; throws only when Outis can't be reached. For engines: call it from an activity or step.
   */
  async execute(requestId: string): Promise<ExecutionResult> {
    if (this.#inFlight.has(requestId)) return this.#finish({ requestId, status: "skipped", reason: "in_flight" }, null);
    this.#inFlight.add(requestId);
    try {
      let claim: Claim;
      try {
        claim = await this.#outis.requests.claim(requestId, { leaseSeconds: this.#lease });
      } catch (err) {
        if (err instanceof OutisApiError && (err.status === 409 || err.status === 410)) {
          return this.#finish({ requestId, status: "skipped", reason: err.kind ?? `http_${err.status}` }, null);
        }
        throw err;
      }
      return await this.#run(claim);
    } finally {
      this.#inFlight.delete(requestId);
    }
  }

  async #run(claim: Claim): Promise<ExecutionResult> {
    const requestId = claim.request.id;
    let intent: OpenedIntent;
    try {
      intent = this.#outis.intents.open(claim.request);
    } catch (err) {
      const reason = err instanceof IntentVerificationError ? err.reason : "bad_intent";
      return this.#report(claim, null, { requestId, status: "failed", reason, error: `${reason}: ${messageOf(err)}` });
    }
    const ctx: ExecutionContext = {
      requestId,
      idempotencyKey: requestId,
      claimId: claim.claimId,
      request: claim.request,
      client: intent.client,
      method: intent.method,
    };
    const base = { requestId, client: intent.client, method: intent.method };
    const name = `${intent.client}.${intent.method}`;
    const refuse = (reason: string, error: string) =>
      this.#report(claim, ctx, { ...base, status: "failed", reason, error: `${reason}: ${error}` });

    if (this.#allow && !this.#allow.some((re) => re.test(name))) return refuse("not_allowed", `${name} isn't allowed`);

    let call: () => unknown;
    const handler = this.#handlers.get(name);
    const registration = this.#clients.get(intent.client);
    if (handler) {
      call = () => handler(ctx, ...intent.args);
    } else if (registration) {
      const target = resolveMethod(registration.client, intent.method);
      if (!target) return refuse("client_not_registered", `${intent.method} isn't a method on ${intent.client}`);
      const args = registration.idempotency ? withIdempotencyKey(intent.args, requestId, registration.idempotency) : intent.args;
      call = () => Reflect.apply(target.fn, target.self, args);
    } else {
      return refuse("client_not_registered", `no client or handler is registered for ${name}`);
    }

    let result: unknown;
    try {
      result = await call();
    } catch (err) {
      return refuse("execution_error", messageOf(err));
    }
    const reference = referenceOf(result);
    return this.#report(claim, ctx, { ...base, status: "succeeded", result, ...(reference ? { reference } : {}) });
  }

  async #report(claim: Claim, ctx: ExecutionContext | null, result: ExecutionResult): Promise<ExecutionResult> {
    try {
      await this.#outis.requests.reportExecution(claim.request.id, {
        claimId: claim.claimId,
        status: result.status === "succeeded" ? "succeeded" : "failed",
        ...(result.reference ? { reference: result.reference } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      result.reported = true;
    } catch (err) {
      result.reported = false;
      this.#onError(err);
    }
    return this.#finish(result, ctx);
  }

  async #finish(result: ExecutionResult, ctx: ExecutionContext | null): Promise<ExecutionResult> {
    if (this.#onResult) {
      try {
        await this.#onResult(result, ctx);
      } catch (err) {
        this.#onError(err);
      }
    }
    return result;
  }

  /**
   * Polls for executable requests every `every` (default 15s) and runs them, `concurrency` at a time.
   * Resolves once `signal` aborts and the runs in flight have finished.
   */
  async run(options: { every?: Duration; signal?: AbortSignal } = {}): Promise<void> {
    const every = parseDuration(options.every ?? "15s");
    const signal = options.signal;
    const limit = Math.min(100, this.#concurrency * 4);
    while (!signal?.aborted) {
      let batch: OutisRequest[] = [];
      try {
        batch = await this.#outis.requests.listExecutable({ limit });
      } catch (err) {
        this.#onError(err);
      }
      await this.#drain(batch.map((r) => r.id), signal);
      if (batch.length === limit) continue;
      try {
        await this.#clock.sleep(every, signal);
      } catch {
        break;
      }
    }
  }

  /**
   * Runs the poll loop until SIGTERM, SIGINT or `signal`, then lets the runs in flight finish and
   * resolves. A second SIGTERM or SIGINT during the drain stops the process as usual.
   */
  async start(options: { every?: Duration; signal?: AbortSignal } = {}): Promise<void> {
    const stop = new AbortController();
    const onStop = () => stop.abort();
    const proc = (globalThis as { process?: NodeJS.Process }).process;
    const signals = ["SIGTERM", "SIGINT"] as const;
    for (const s of signals) proc?.once(s, onStop);
    if (options.signal?.aborted) stop.abort();
    options.signal?.addEventListener("abort", onStop, { once: true });
    try {
      await this.run({ ...(options.every !== undefined ? { every: options.every } : {}), signal: stop.signal });
    } finally {
      for (const s of signals) proc?.off(s, onStop);
      options.signal?.removeEventListener("abort", onStop);
    }
  }

  /** One pass: lists what's executable and runs it. For cron style hosts (a Cloudflare cron trigger, a scheduled job). */
  async poll(options: { limit?: number } = {}): Promise<ExecutionResult[]> {
    const batch = await this.#outis.requests.listExecutable({ limit: options.limit ?? Math.min(100, this.#concurrency * 4) });
    return this.#drain(batch.map((r) => r.id), undefined);
  }

  async #drain(ids: string[], signal: AbortSignal | undefined): Promise<ExecutionResult[]> {
    const queue = [...ids];
    const results: ExecutionResult[] = [];
    const lane = async () => {
      for (let id = queue.shift(); id !== undefined && !signal?.aborted; id = queue.shift()) {
        try {
          results.push(await this.execute(id));
        } catch (err) {
          this.#onError(err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, queue.length) }, lane));
    return results;
  }

  /**
   * Handles one webhook delivery: verifies it, and runs the request on `request.authorized` when it
   * carries an intent. 400 on a bad signature, 500 when Outis couldn't be reached (so it redelivers).
   */
  async deliver(
    rawBody: string | Uint8Array,
    headers: HeaderSource,
    secret: WebhookSecret | readonly WebhookSecret[],
  ): Promise<{ status: number; body: unknown }> {
    let event;
    try {
      event = verifyWebhook(rawBody, headers, secret);
    } catch (err) {
      if (err instanceof WebhookVerificationError) return { status: 400, body: { error: err.message } };
      throw err;
    }
    if (event.type !== "request.authorized" || !event.data.request.intent) {
      return { status: 200, body: { ignored: event.type } };
    }
    try {
      return { status: 200, body: { result: summary(await this.execute(event.data.request.id)) } };
    } catch (err) {
      this.#onError(err);
      return { status: 500, body: { error: "couldn't reach Outis" } };
    }
  }

  /** A Node `http` or Express handler. With Express, mount it behind `express.raw({ type: "application/json" })`. */
  handler(
    secret: WebhookSecret | readonly WebhookSecret[],
  ): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void> {
    return async (req, res) => {
      let answer: { status: number; body: unknown };
      try {
        answer = await this.deliver(await readNodeBody(req), req.headers, secret);
      } catch (err) {
        this.#onError(err);
        answer = { status: 500, body: { error: messageOf(err) } };
      }
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    };
  }

  /** A fetch style handler, `(Request) => Response`: Next route handlers, Cloudflare Workers, Deno, Bun. */
  fetchHandler(secret: WebhookSecret | readonly WebhookSecret[]): (request: Request) => Promise<Response> {
    return async (request) => {
      const raw = new Uint8Array(await request.arrayBuffer());
      const answer = await this.deliver(raw, request.headers, secret);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    };
  }
}

function summary(result: ExecutionResult): Omit<ExecutionResult, "result"> {
  const { result: _omit, ...rest } = result;
  return rest;
}
