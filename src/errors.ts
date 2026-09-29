import type { OutisRequest, Outcome } from "./types.js";

/** The base class of every error this package throws on purpose. */
export class OutisError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API answered with a refusal. `kind` is the API's machine-readable error, when it sent one. */
export class OutisApiError extends OutisError {
  readonly status: number;
  readonly kind: string | undefined;
  readonly body: unknown;

  constructor(status: number, message: string, kind: string | undefined, body: unknown) {
    super(`Outis API ${status}: ${message}`);
    this.status = status;
    this.kind = kind;
    this.body = body;
  }

  /** The same value as `kind`. */
  get code(): string | undefined {
    return this.kind;
  }
}

/** A 409: the idempotency key was already used for a different operation. */
export class IdempotencyConflictError extends OutisApiError {}

/** The API couldn't be reached at all (DNS, TLS, a dropped connection). */
export class OutisConnectionError extends OutisError {}

/** A bounded wait ran out. The request is still live; resume it later with `requestId`. */
export class WaitTimeoutError extends OutisError {
  readonly requestId: string;
  readonly request: OutisRequest;

  constructor(request: OutisRequest, timeoutMs: number) {
    super(
      `request ${request.id} is still ${request.state} after ${timeoutMs}ms; ` +
        "retrieve it later, or use guard with deferTo and a worker for approvals that take longer",
    );
    this.requestId = request.id;
    this.request = request;
  }
}

/** The request ended without authorization, or isn't decided yet (`outcome` null). */
export class NotAuthorizedError extends OutisError {
  readonly request: OutisRequest;
  readonly outcome: Exclude<Outcome, "authorized"> | null;

  constructor(request: OutisRequest) {
    const outcome = request.outcome === "authorized" ? null : request.outcome;
    super(
      outcome === null
        ? `request ${request.id} isn't decided yet (state ${request.state})`
        : `request ${request.id} was not authorized: ${outcome}`,
    );
    this.request = request;
    this.outcome = outcome;
  }
}

/** The authorized request is for a different operation than the one about to run. */
export class OperationMismatchError extends OutisError {
  readonly request: OutisRequest;
  readonly expected: string;
  readonly actual: string;

  constructor(request: OutisRequest, expected: string, actual: string) {
    super(
      `request ${request.id} authorized ${actual}, but the operation about to run hashes to ${expected}`,
    );
    this.request = request;
    this.expected = expected;
    this.actual = actual;
  }
}

/** An intent failed a check before anything ran. `reason` is the code a worker reports it under. */
export class IntentVerificationError extends OutisError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** A webhook delivery failed verification. Answer it with a 400 and don't act on it. */
export class WebhookVerificationError extends OutisError {}
