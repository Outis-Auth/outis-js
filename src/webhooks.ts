import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./errors.js";
import { decodeRequest, type OutisEvent } from "./types.js";

/** Headers as fetch, Node's `IncomingMessage` or a plain object carry them. */
export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | Iterable<[string, string]>;

export interface VerifyOptions {
  /** How far the signature's timestamp may drift from now. Defaults to 300. */
  toleranceSeconds?: number;
  /** The current time, as a Date or epoch milliseconds. Defaults to the system clock. */
  now?: Date | number;
}

/** A signing secret: an endpoint's `whsec_...` string, used as its UTF-8 bytes, or raw key bytes. */
export type WebhookSecret = string | Uint8Array;

/**
 * The key a request's `callbackUrl` deliveries are signed with, derived from the API key that
 * created the request: HMAC-SHA256 keyed by the token, over "outis/callback-key/v1".
 */
export function callbackSecret(apiKey: string): Uint8Array {
  if (typeof apiKey !== "string" || apiKey === "") throw new TypeError("apiKey is required");
  return createHmac("sha256", Buffer.from(apiKey, "utf8")).update("outis/callback-key/v1", "utf8").digest();
}

/** The header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const SIGNATURE_HEADER = "outis-signature";

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  if (Symbol.iterator in (headers as object) && !Array.isArray(headers)) {
    for (const [k, v] of headers as Iterable<[string, string]>) {
      if (k.toLowerCase() === name) return v;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() !== name || v === undefined) continue;
    return Array.isArray(v) ? v.join(",") : v;
  }
  return undefined;
}

function parseSignature(value: string): { t: number; v1: string[] } {
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of value.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(val)) t = Number(val);
    else if (key === "v1" && /^[0-9a-fA-F]{64}$/.test(val)) v1.push(val.toLowerCase());
  }
  if (t === undefined) throw new WebhookVerificationError("Outis-Signature has no timestamp");
  if (v1.length === 0) throw new WebhookVerificationError("Outis-Signature has no v1 signature");
  return { t, v1 };
}

/**
 * Checks an Outis webhook delivery and returns its event. Pass the raw body exactly as it arrived,
 * before any JSON parsing. `secret` may be a list, so a receiver keeps working while you rotate.
 */
export function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: HeaderSource,
  secret: WebhookSecret | readonly WebhookSecret[],
  options: VerifyOptions = {},
): OutisEvent {
  const list = typeof secret === "string" || secret instanceof Uint8Array ? [secret] : [...secret];
  const secrets = list
    .map((s) => (typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s)))
    .filter((s) => s.length > 0);
  if (secrets.length === 0) throw new TypeError("a webhook secret is required");
  const value = header(headers, SIGNATURE_HEADER);
  if (!value) throw new WebhookVerificationError("no Outis-Signature header");
  const { t, v1 } = parseSignature(value);

  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now === undefined ? Date.now() : Number(options.now);
  if (Math.abs(now / 1000 - t) > tolerance) {
    throw new WebhookVerificationError("Outis-Signature timestamp is outside the tolerance");
  }

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const signed = Buffer.concat([Buffer.from(`${t}.`, "utf8"), body]);
  const matched = secrets.some((s) => {
    const expected = createHmac("sha256", s).update(signed).digest();
    return v1.some((sig) => timingSafeEqual(expected, Buffer.from(sig, "hex")));
  });
  if (!matched) throw new WebhookVerificationError("Outis-Signature doesn't match the body");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new WebhookVerificationError("the signed body isn't JSON");
  }
  const env = parsed as { id?: unknown; type?: unknown; created_at?: unknown; org?: unknown; data?: unknown };
  if (typeof env.id !== "string" || typeof env.type !== "string") {
    throw new WebhookVerificationError("the signed body isn't an Outis event");
  }
  const data = (env.data ?? {}) as { request?: unknown };
  let request;
  try {
    request = decodeRequest(data.request);
  } catch {
    throw new WebhookVerificationError("the event carries no request");
  }
  return {
    id: env.id,
    type: env.type,
    createdAt: typeof env.created_at === "string" ? env.created_at : "",
    org: typeof env.org === "string" ? env.org : "",
    data: { request },
  };
}
