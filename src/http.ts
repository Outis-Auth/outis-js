import type { Clock } from "./clock.js";
import { IdempotencyConflictError, OutisApiError, OutisConnectionError } from "./errors.js";
import { VERSION } from "./version.js";

export interface Transport {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  clock: Clock;
  maxRetries: number;
}

export interface Call {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Whether a 429, a 5xx or a dropped connection may be retried. */
  retry: boolean;
  signal?: AbortSignal;
}

export interface Answer {
  status: number;
  headers: Headers;
  body: unknown;
}

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8_000;

function retryDelay(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function refusal(status: number, body: unknown): OutisApiError {
  let message = `HTTP ${status}`;
  let kind: string | undefined;
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; code?: unknown; kind?: unknown; message?: unknown };
    if (typeof b.error === "string") message = b.error;
    else if (typeof b.message === "string") message = b.message;
    if (typeof b.kind === "string") kind = b.kind;
    else if (typeof b.code === "string") kind = b.code;
  } else if (typeof body === "string" && body !== "") {
    message = body;
  }
  if (status === 409 && kind === "idempotency_conflict") {
    return new IdempotencyConflictError(status, message, kind, body);
  }
  return new OutisApiError(status, message, kind, body);
}

/** Sends one API call, retrying transient failures when the call allows it. */
export async function send(t: Transport, call: Call): Promise<Answer> {
  const url = t.baseUrl.replace(/\/+$/, "") + call.path;
  const headers: Record<string, string> = {
    authorization: `Bearer ${t.apiKey}`,
    accept: "application/json",
    "user-agent": `outis-js/${VERSION}`,
    ...call.headers,
  };
  let payload: string | undefined;
  if (call.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(call.body);
  }
  const attempts = call.retry ? t.maxRetries + 1 : 1;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await t.fetch(url, {
        method: call.method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        ...(call.signal ? { signal: call.signal } : {}),
      });
    } catch (err) {
      if (call.signal?.aborted) throw call.signal.reason;
      if (attempt + 1 < attempts) {
        await t.clock.sleep(retryDelay(attempt, null), call.signal);
        continue;
      }
      throw new OutisConnectionError(`couldn't reach Outis at ${url}`, { cause: err });
    }
    const body = await readBody(res);
    if (res.ok) return { status: res.status, headers: res.headers, body };
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt + 1 < attempts) {
      await t.clock.sleep(retryDelay(attempt, res.headers.get("retry-after")), call.signal);
      continue;
    }
    throw refusal(res.status, body);
  }
}
