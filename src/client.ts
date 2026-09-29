import { systemClock, type Clock } from "./clock.js";
import { parseDuration, parseWaitTimeout, type Duration } from "./duration.js";
import { NotAuthorizedError, OperationMismatchError, WaitTimeoutError } from "./errors.js";
import { operationHash } from "./hash.js";
import { send, type Transport } from "./http.js";
import {
  encodeIntent,
  intentDigest,
  INTENT_PARAM,
  openIntent,
  resolveIntentKeys,
  sealIntent,
  type IntentKey,
  type OpenedIntent,
} from "./intents.js";
import {
  decodeEnvelope,
  decodeRequest,
  type CreateRequestInput,
  type CreatedRequest,
  type OutisEvent,
  type OutisRequest,
} from "./types.js";
import { verifyWebhook, type HeaderSource, type VerifyOptions, type WebhookSecret } from "./webhooks.js";
import { Worker, type WorkerOptions } from "./worker.js";
import {
  guard,
  guardMethod,
  type ArgsOf,
  type Deferred,
  type GuardDeferOptions,
  type GuardedDefer,
  type GuardedWait,
  type GuardMethodDeferOptions,
  type GuardMethodOptions,
  type GuardMethodWaitOptions,
  type GuardOptions,
  type GuardWaitOptions,
  type MethodKeys,
} from "./guard.js";
import { wrap, type Guarded, type WrapMethods, type WrapOptions } from "./wrap.js";

export interface OutisOptions {
  /** A service token with the `propose` scope to create and `read` to observe. */
  apiKey: string;
  /** Defaults to https://api.outis.tech. */
  baseUrl?: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** How many times a retryable call is retried on a 429, a 5xx or a dropped connection. Defaults to 2. */
  maxRetries?: number;
  /** Defaults to the system clock. Tests pass a fake one. */
  clock?: Clock;
  /**
   * The key intents are sealed with, or several while you rotate (the first one seals, any opens).
   * Defaults to `OUTIS_INTENT_KEYS`, then `OUTIS_INTENT_KEY`, from the environment.
   */
  intentKey?: IntentKey | readonly IntentKey[];
  /** The `requester` a `guard` call uses when it doesn't name one. */
  requester?: string;
}

export interface CreateOptions {
  /** Sent as `Idempotency-Key`. The same key and operation return the original request. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface WaitOptions {
  /** Required, at most 30 minutes. */
  timeout: Duration;
  signal?: AbortSignal;
}

/** A call to seal and propose: what the operators approve, and the exact call a worker will make. */
export interface ProposeIntentInput extends Omit<CreateRequestInput, "intent"> {
  /** The name your worker registered the client under. */
  client: string;
  /** A dotted path on that client, ie `transfers.create`. */
  method: string;
  /** Positional arguments, plain JSON data only. */
  args: unknown[];
}

/** A proposed intent that's waiting on people. Store `requestId` if you want to follow it. */
export interface PendingExecution {
  status: "pending";
  requestId: string;
  request: OutisRequest;
  intentDigest: string;
}

/** What a claim hands back: the lease, and the request as it stood when claimed. */
export interface Claim {
  claimId: string;
  leaseExpiresAt: Date | null;
  request: OutisRequest;
}

/** A worker's report on the run it claimed. */
export interface ExecutionReport {
  claimId: string;
  status: "succeeded" | "failed";
  /** At most 512 characters, ie the downstream object's id. */
  reference?: string;
  /** At most 512 characters. */
  error?: string;
}

/** The operation an executor is about to run. */
export interface ExpectedOperation {
  action: string;
  params?: Record<string, string>;
}

const MAX_EXECUTE_WITHIN_S = 30 * 86_400;
const REPORT_TEXT_MAX = 512;

const POLL_START_MS = 1_000;
const POLL_CAP_MS = 10_000;
const POLL_GROWTH = 1.5;

/** @internal */
export function checkIdempotencyKey(key: string): void {
  if (key.length < 1 || key.length > 255 || !/^[\x20-\x7e]+$/.test(key)) {
    throw new TypeError("idempotencyKey must be 1 to 255 printable ASCII characters");
  }
}

function checkParams(params: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v !== "string") throw new TypeError(`param "${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

/** Create, read and wait on requests. */
export class Requests {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** Asks Outis to authorize an operation. Resolves once people have been asked, not once they've decided. */
  async create(input: CreateRequestInput, options: CreateOptions = {}): Promise<CreatedRequest> {
    if (!input || typeof input.action !== "string" || input.action === "") {
      throw new TypeError("action is required");
    }
    if (typeof input.requester !== "string" || input.requester === "") {
      throw new TypeError("requester is required");
    }
    const body: Record<string, unknown> = {
      action: input.action,
      requester: input.requester,
      params: checkParams(input.params),
    };
    if (input.summary !== undefined) body.summary = input.summary;
    if (input.callbackUrl !== undefined) body.callback_url = input.callbackUrl;
    if (input.quorum !== undefined) body.quorum = input.quorum;
    if (input.intent !== undefined) body.intent = input.intent;
    if (input.executeWithin !== undefined) {
      const seconds = Math.ceil(parseDuration(input.executeWithin) / 1000);
      if (seconds < 1 || seconds > MAX_EXECUTE_WITHIN_S) throw new RangeError("executeWithin must be between 1s and 30d");
      body.execute_within = seconds;
    }

    const headers: Record<string, string> = {};
    if (options.idempotencyKey !== undefined) {
      checkIdempotencyKey(options.idempotencyKey);
      headers["idempotency-key"] = options.idempotencyKey;
    }
    const answer = await send(this.#t, {
      method: "POST",
      path: "/v1/requests",
      body,
      headers,
      retry: options.idempotencyKey !== undefined,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      ...decodeEnvelope(answer.body),
      replayed: answer.headers.get("idempotent-replayed") === "true",
    };
  }

  /** Reads one request as it stands now. */
  async retrieve(id: string, options: { signal?: AbortSignal } = {}): Promise<OutisRequest> {
    if (typeof id !== "string" || id === "") throw new TypeError("id is required");
    const answer = await send(this.#t, {
      method: "GET",
      path: `/v1/requests/${encodeURIComponent(id)}`,
      retry: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return decodeEnvelope(answer.body);
  }

  /**
   * Polls until the request is decided, whatever the outcome. Throws WaitTimeoutError once
   * `timeout` passes; the request is still live then, so keep its id and resume later.
   */
  async waitFor(id: string, options: WaitOptions): Promise<OutisRequest> {
    const timeoutMs = parseWaitTimeout(options?.timeout);
    const clock = this.#t.clock;
    const signal = options.signal;
    const deadline = clock.now() + timeoutMs;
    let delay = POLL_START_MS;
    for (;;) {
      signal?.throwIfAborted();
      const request = await this.retrieve(id, signal ? { signal } : {});
      if (request.outcome !== null) return request;
      const remaining = deadline - clock.now();
      if (remaining <= 0) throw new WaitTimeoutError(request, timeoutMs);
      const jittered = delay * (0.8 + Math.random() * 0.4);
      await clock.sleep(Math.min(jittered, remaining), signal);
      delay = Math.min(POLL_CAP_MS, delay * POLL_GROWTH);
    }
  }

  /** Authorized requests with an unclaimed intent, oldest first. Needs the `execute` scope. */
  async listExecutable(options: { limit?: number; signal?: AbortSignal } = {}): Promise<OutisRequest[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
    const answer = await send(this.#t, {
      method: "GET",
      path: `/v1/requests?executable=true&limit=${limit}`,
      retry: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const list = (answer.body as { requests?: unknown } | null)?.requests;
    return Array.isArray(list) ? list.map(decodeRequest) : [];
  }

  /**
   * Claims a request's intent for one run, under a lease. Only one claim is live at a time; a 409
   * (`already_claimed`, `already_reported`, `not_authorized`) or 410 (`execution_window_closed`)
   * throws OutisApiError with that `kind`. Needs the `execute` scope.
   */
  async claim(id: string, options: { leaseSeconds?: number; signal?: AbortSignal } = {}): Promise<Claim> {
    if (typeof id !== "string" || id === "") throw new TypeError("id is required");
    const lease = options.leaseSeconds ?? 600;
    if (!Number.isInteger(lease) || lease < 1 || lease > 3600) {
      throw new RangeError("leaseSeconds must be a whole number from 1 to 3600");
    }
    const answer = await send(this.#t, {
      method: "POST",
      path: `/v1/requests/${encodeURIComponent(id)}/claim`,
      body: { lease_seconds: lease },
      retry: false,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const b = (answer.body ?? {}) as { claim_id?: unknown; lease_expires_at?: unknown; request?: unknown };
    if (typeof b.claim_id !== "string") throw new TypeError("the claim answer has no claim_id");
    const expires = typeof b.lease_expires_at === "number" ? new Date(b.lease_expires_at) : null;
    return { claimId: b.claim_id, leaseExpiresAt: expires, request: decodeRequest(b.request) };
  }

  /** Reports how a claimed run went. Safe to repeat for the same claim and status. */
  async reportExecution(id: string, report: ExecutionReport, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (typeof id !== "string" || id === "") throw new TypeError("id is required");
    if (report.status !== "succeeded" && report.status !== "failed") {
      throw new TypeError('status must be "succeeded" or "failed"');
    }
    const body: Record<string, unknown> = { claim_id: report.claimId, status: report.status };
    if (report.reference) body.reference = report.reference.slice(0, REPORT_TEXT_MAX);
    if (report.error) body.error = report.error.slice(0, REPORT_TEXT_MAX);
    await send(this.#t, {
      method: "POST",
      path: `/v1/requests/${encodeURIComponent(id)}/execution`,
      body,
      retry: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /**
   * The executor's check: the request is authorized, and for exactly this operation.
   * Call it right before you run anything on a request's say-so.
   */
  async assertAuthorized(
    id: string,
    expected: ExpectedOperation,
    options: { signal?: AbortSignal } = {},
  ): Promise<OutisRequest> {
    const request = await this.retrieve(id, options);
    if (request.outcome !== "authorized") throw new NotAuthorizedError(request);
    const want = operationHash(expected.action, checkParams(expected.params));
    const got = request.operationHash || operationHash(request.action, request.params);
    if (want !== got) throw new OperationMismatchError(request, want, got);
    return request;
  }
}

/** Seal a call, propose it, and open it again on the worker side. */
export class Intents {
  readonly #requests: Requests;
  readonly #keys: IntentKey[];

  constructor(requests: Requests, keys: IntentKey[]) {
    this.#requests = requests;
    this.#keys = keys;
  }

  /** The keys this client seals and opens with. The first one seals. */
  get keys(): readonly IntentKey[] {
    return this.#keys;
  }

  /**
   * Seals the call under your intent key and creates the request, with the intent's digest in
   * `params.intent` so the approval binds the exact call. Nothing runs here.
   */
  async propose(
    input: ProposeIntentInput,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<PendingExecution> {
    const key = this.#keys[0];
    if (key === undefined) {
      throw new TypeError("no intent key: pass intentKey to new Outis() or set OUTIS_INTENT_KEY");
    }
    const { client, method, args, ...request } = input;
    if (request.params && Object.hasOwn(request.params, INTENT_PARAM)) {
      throw new TypeError(`params.${INTENT_PARAM} is reserved for the intent's digest`);
    }
    const plaintext = encodeIntent({ client, method, args });
    const digest = intentDigest(plaintext);
    const created = await this.#requests.create(
      {
        ...request,
        params: { ...request.params, [INTENT_PARAM]: digest },
        intent: sealIntent(key, request.action, plaintext),
      },
      options,
    );
    return { status: "pending", requestId: created.id, request: created, intentDigest: digest };
  }

  /** Opens and checks a request's intent. Throws IntentVerificationError, with a `reason`, on any miss. */
  open(request: OutisRequest): OpenedIntent {
    return openIntent(this.#keys, request);
  }
}

/** Webhook helpers. Verification needs only the endpoint's secret, not an API key. */
export class Webhooks {
  /** Checks a delivery's signature and freshness, then returns its event. */
  verify(
    rawBody: string | Uint8Array,
    headers: HeaderSource,
    secret: WebhookSecret | readonly WebhookSecret[],
    options?: VerifyOptions,
  ): OutisEvent {
    return verifyWebhook(rawBody, headers, secret, options);
  }
}

/** The Outis client. */
export class Outis {
  readonly requests: Requests;
  readonly intents: Intents;
  readonly webhooks: Webhooks;
  readonly #requester: string | undefined;

  constructor(options: OutisOptions) {
    if (!options || typeof options.apiKey !== "string" || options.apiKey === "") {
      throw new TypeError("apiKey is required");
    }
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new TypeError("no fetch available; pass one in options.fetch");
    const transport: Transport = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? "https://api.outis.tech",
      fetch: f,
      clock: options.clock ?? systemClock,
      maxRetries: options.maxRetries ?? 2,
    };
    this.requests = new Requests(transport);
    this.intents = new Intents(this.requests, resolveIntentKeys(options.intentKey));
    this.webhooks = new Webhooks();
    this.#requester = options.requester;
  }

  /**
   * Asks the approvers and resolves once they decide. With `wait`: resolves with the authorized
   * request, or rejects with NotAuthorizedError or WaitTimeoutError. With `deferTo`: seals the call,
   * resolves with a Deferred handle once the request exists, and a worker runs the call later.
   * Outis never runs anything itself.
   */
  guard(options: GuardWaitOptions): Promise<OutisRequest>;
  guard(options: GuardDeferOptions): Promise<Deferred>;
  guard(options: GuardOptions): Promise<OutisRequest | Deferred> {
    return guard(this, this.#requester, options);
  }

  /**
   * Guards one method of an object you already use. The returned function takes the method's own
   * arguments. With `wait`, it runs the method on `target` once approved; with `deferTo`, it seals the
   * call for a worker and resolves with a Deferred handle.
   */
  guardMethod<T extends object, K extends MethodKeys<T>>(
    target: T,
    method: K,
    options: GuardMethodWaitOptions<ArgsOf<T[K]>>,
  ): GuardedWait<T[K]>;
  guardMethod<T extends object, K extends MethodKeys<T>>(
    target: T,
    method: K,
    options: GuardMethodDeferOptions<ArgsOf<T[K]>>,
  ): GuardedDefer<T[K]>;
  guardMethod(target: object, method: string, options: GuardMethodOptions): (...args: unknown[]) => Promise<unknown> {
    return guardMethod(this, target, method, options);
  }

  /**
   * Returns a proxy of `target` whose listed methods ask Outis first. Everything else passes
   * through. See WrapOptions for the three modes.
   */
  wrap<T extends object, M extends WrapMethods, O extends WrapOptions>(
    target: T,
    methods: M,
    options: O,
  ): Guarded<T, keyof M & string, O["mode"]> {
    return wrap(this, target, methods, options);
  }

  /** A worker that claims authorized intents and runs them against the clients you register. */
  worker(options: WorkerOptions): Worker {
    return new Worker(this, options);
  }
}
