import type { Duration } from "./duration.js";

/** Where a request is. Pending is proposed, notified or staging; the rest are decided. */
export type RequestState =
  | "proposed"
  | "notified"
  | "staging"
  | "authorized"
  | "executing"
  | "succeeded"
  | "failed"
  | "expired"
  | "aborted"
  | "denied";

/** How a request ended. Null on a request while it's live. */
export type Outcome = "authorized" | "denied" | "expired" | "aborted";

/** One request, as `GET /v1/requests/{id}` reads it. */
export interface OutisRequest {
  id: string;
  action: string;
  requester: string;
  state: RequestState;
  /** Whether the request can still change. */
  live: boolean;
  /** Null while live. */
  outcome: Outcome | null;
  /** Who turned a key. Empty unless authorized. */
  approvers: string[];
  /** What was proposed, which is what the operators saw. */
  params: Record<string, string>;
  /** `operationHash(action, params)` as the server computed it. */
  operationHash: string;
  createdAt: Date;
  /** Null while live. */
  decidedAt: Date | null;
  /** The request is still live (same as `live`). */
  isPending: boolean;
  /** The required people authorized it. */
  isAuthorized: boolean;
  /** The sealed intent, exactly as the proposer sent it, or null. Outis can't read it. */
  intent: IntentEnvelope | null;
  /** Your worker's run of the intent. State `none` when there's no intent. */
  execution: Execution;
}

/** An intent sealed with AES-256-GCM under a key only you hold. */
export interface IntentEnvelope {
  v: 1;
  alg: "A256GCM";
  /** First 16 hex characters of SHA-256 over the key bytes. */
  kid: string;
  /** base64url, 12 bytes. */
  nonce: string;
  /** base64url, with the 16 byte GCM tag at the end. */
  ciphertext: string;
}

/** Where a sealed intent's run stands. `pending` means authorized and not yet claimed. */
export type ExecutionState = "none" | "pending" | "claimed" | "succeeded" | "failed";

/** The record of a worker's run, separate from the request's own state. */
export interface Execution {
  state: ExecutionState;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  reportedAt: Date | null;
  reference: string | null;
  error: string | null;
  /** After this, the intent can no longer be claimed. */
  executeBy: Date | null;
}

/** What `requests.create` returns: the request, and whether an idempotency key replayed it. */
export interface CreatedRequest extends OutisRequest {
  /** True when the API answered with the request an earlier call made under the same idempotency key. */
  replayed: boolean;
}

/** What a caller asks Outis to authorize. */
export interface CreateRequestInput {
  /** The action name, ie `deploy.production`. Policy for it lives in Outis. */
  action: string;
  /** Who is asking, as an Outis operator name. */
  requester: string;
  /** What the operators see and approve. Values are strings. */
  params?: Record<string, string>;
  summary?: string;
  /** Outis posts the signed decision here once the request ends. */
  callbackUrl?: string;
  quorum?: number;
  /** A sealed intent. `intents.propose` fills this and `executeWithin` for you. */
  intent?: IntentEnvelope;
  /** How long after authorization a worker may claim the intent. Default 7 days, at most 30. */
  executeWithin?: Duration;
}

/** The webhook event types Outis sends. */
export type OutisEventType =
  | "request.authorized"
  | "request.denied"
  | "request.expired"
  | "request.aborted"
  | "request.failed"
  | "request.executed"
  | "request.execution_failed";

/** A verified webhook delivery. Dedupe on `id`. */
export interface OutisEvent {
  id: string;
  type: OutisEventType | (string & {});
  /** RFC 3339, as sent. */
  createdAt: string;
  org: string;
  data: { request: OutisRequest };
}

type WireRequest = {
  id?: unknown;
  action?: unknown;
  requester?: unknown;
  state?: unknown;
  live?: unknown;
  outcome?: unknown;
  approvers?: unknown;
  params?: unknown;
  operation_hash?: unknown;
  created_at?: unknown;
  decided_at?: unknown;
  intent?: unknown;
  execution?: unknown;
};

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function decodeIntent(raw: unknown): IntentEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.kid !== "string" || typeof e.nonce !== "string" || typeof e.ciphertext !== "string") return null;
  return { v: e.v as 1, alg: e.alg as "A256GCM", kid: e.kid, nonce: e.nonce, ciphertext: e.ciphertext };
}

function decodeExecution(raw: unknown): Execution {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    state: (str(e.state) ?? "none") as ExecutionState,
    claimedAt: toDate(e.claimed_at),
    leaseExpiresAt: toDate(e.lease_expires_at),
    reportedAt: toDate(e.reported_at),
    reference: str(e.reference) || null,
    error: str(e.error) || null,
    executeBy: toDate(e.execute_by),
  };
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    const d = new Date(/^\d+$/.test(value) ? Number(value) : value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Reads the API's request object (snake_case, millisecond times) into an OutisRequest. */
export function decodeRequest(raw: unknown): OutisRequest {
  if (!raw || typeof raw !== "object") throw new TypeError("expected a request object");
  const w = raw as WireRequest;
  if (typeof w.id !== "string") throw new TypeError("request object has no id");
  const outcome = (typeof w.outcome === "string" ? w.outcome : null) as Outcome | null;
  const live = typeof w.live === "boolean" ? w.live : outcome === null;
  const params: Record<string, string> = {};
  if (w.params && typeof w.params === "object") {
    for (const [k, v] of Object.entries(w.params as Record<string, unknown>)) {
      if (typeof v === "string") params[k] = v;
    }
  }
  return {
    id: w.id,
    action: typeof w.action === "string" ? w.action : "",
    requester: typeof w.requester === "string" ? w.requester : "",
    state: (typeof w.state === "string" ? w.state : "proposed") as RequestState,
    live,
    outcome,
    approvers: Array.isArray(w.approvers) ? w.approvers.filter((a): a is string => typeof a === "string") : [],
    params,
    operationHash: typeof w.operation_hash === "string" ? w.operation_hash : "",
    createdAt: toDate(w.created_at) ?? new Date(0),
    decidedAt: toDate(w.decided_at),
    isPending: live,
    isAuthorized: outcome === "authorized",
    intent: decodeIntent(w.intent),
    execution: decodeExecution(w.execution),
  };
}

/** Reads a decision body: the `{server_now, request}` envelope, or a bare request object. */
export function decodeEnvelope(body: unknown): OutisRequest {
  if (body && typeof body === "object" && "request" in body) {
    return decodeRequest((body as { request: unknown }).request);
  }
  return decodeRequest(body);
}
