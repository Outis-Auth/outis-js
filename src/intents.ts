import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { IntentVerificationError } from "./errors.js";
import { operationHash } from "./hash.js";
import type { IntentEnvelope, OutisRequest } from "./types.js";

/** A key as `OUTIS_INTENT_KEY` holds it (base64, standard or url alphabet, of 32 bytes), or the raw bytes. */
export type IntentKey = string | Uint8Array;

/** What a sealed intent says to run: a method on a client the worker registered, with JSON arguments. */
export interface Intent {
  client: string;
  /** A dotted path on the client, ie `transfers.create`. */
  method: string;
  args: unknown[];
}

/** An intent a worker opened and checked against its request. */
export interface OpenedIntent extends Intent {
  v: 1;
  /** The plaintext exactly as the proposer produced it. */
  plaintext: string;
  digest: string;
  kid: string;
}

/** The params key the intent's digest rides under, so the operators' approval binds the exact call. */
export const INTENT_PARAM = "intent";

const INTENT_FIELDS = new Set(["v", "client", "method", "args", "kwargs"]);
const AAD_PREFIX = "outis.intent.v1\u0000";
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function fromBase64(value: string): Buffer | undefined {
  const text = value.trim();
  return B64.test(text) ? Buffer.from(text, "base64") : undefined;
}

/** Reads one intent key into its 32 bytes. Throws a TypeError on anything else. */
export function parseIntentKey(key: IntentKey): Buffer {
  const bytes = typeof key === "string" ? fromBase64(key) : Buffer.from(key);
  if (!bytes || bytes.length !== 32) {
    throw new TypeError("an intent key must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  }
  return bytes;
}

/** The key id an envelope names: the first 16 hex characters of SHA-256 over the key bytes. */
export function intentKeyId(key: IntentKey): string {
  return createHash("sha256").update(parseIntentKey(key)).digest("hex").slice(0, 16);
}

/** `"sha256:" + hex(SHA-256(plaintext bytes))`, the value a request's `params.intent` carries. */
export function intentDigest(plaintext: string | Uint8Array): string {
  const bytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function plainJson(value: unknown, path: string, stack: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`intent ${path} is ${value}, which JSON can't carry`);
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`intent ${path} is an invalid Date`);
    return value.toISOString();
  }
  if (typeof value !== "object") {
    throw new TypeError(`intent ${path} is a ${typeof value}; only plain JSON data can be sealed`);
  }
  if (stack.has(value)) throw new TypeError(`intent ${path} refers back to itself`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, i) => {
        if (item === undefined) throw new TypeError(`intent ${path}[${i}] is undefined`);
        return plainJson(item, `${path}[${i}]`, stack);
      });
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new TypeError(`intent ${path} is a ${name}; only plain objects, arrays and Dates can be sealed`);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = plainJson(v, `${path}.${k}`, stack);
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

/**
 * Serializes an intent to the plaintext every Outis SDK agrees on. Trailing undefined arguments are
 * dropped; anything that isn't plain JSON data (functions, class instances, BigInt, NaN) throws.
 */
export function encodeIntent(intent: Intent): string {
  if (typeof intent?.client !== "string" || intent.client === "") throw new TypeError("intent client is required");
  if (typeof intent.method !== "string" || intent.method === "") throw new TypeError("intent method is required");
  if (!Array.isArray(intent.args)) throw new TypeError("intent args must be an array");
  const args = [...intent.args];
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
  const clean = plainJson(args, "args", new Set());
  return JSON.stringify({ v: 1, client: intent.client, method: intent.method, args: clean });
}

function aad(action: string): Buffer {
  return Buffer.from(AAD_PREFIX + action, "utf8");
}

/**
 * Encrypts a plaintext intent for one action with AES-256-GCM. `nonce` is for test vectors only;
 * leave it out and a random one is drawn, as it must be for every real seal.
 */
export function sealIntent(key: IntentKey, action: string, plaintext: string, nonce?: Uint8Array): IntentEnvelope {
  const k = parseIntentKey(key);
  const iv = nonce ? Buffer.from(nonce) : randomBytes(12);
  if (iv.length !== 12) throw new TypeError("an intent nonce is 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  cipher.setAAD(aad(action));
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    alg: "A256GCM",
    kid: intentKeyId(k),
    nonce: iv.toString("base64url"),
    ciphertext: sealed.toString("base64url"),
  };
}

/** Decrypts an envelope with whichever of `keys` its kid names. Throws IntentVerificationError. */
export function unsealIntent(keys: readonly IntentKey[], action: string, envelope: IntentEnvelope): string {
  if (!envelope || envelope.v !== 1 || envelope.alg !== "A256GCM") {
    throw new IntentVerificationError("bad_intent", "the intent envelope isn't v1 A256GCM");
  }
  const key = keys.map(parseIntentKey).find((k) => intentKeyId(k) === envelope.kid);
  if (!key) throw new IntentVerificationError("unknown_key", `no intent key with kid ${envelope.kid}`);
  const iv = fromBase64(envelope.nonce);
  const sealed = fromBase64(envelope.ciphertext);
  if (!iv || iv.length !== 12 || !sealed || sealed.length < 16) {
    throw new IntentVerificationError("bad_intent", "the intent envelope's nonce or ciphertext is malformed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(action));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new IntentVerificationError("decrypt_failed", "the intent didn't decrypt under its key for this action");
  }
}

/**
 * Opens a request's intent and checks, in order: key, decryption for the request's action, the digest
 * in `params.intent`, the operation hash, and the outcome. Throws IntentVerificationError on the first miss.
 */
export function openIntent(keys: readonly IntentKey[], request: OutisRequest): OpenedIntent {
  if (!request.intent) throw new IntentVerificationError("no_intent", `request ${request.id} carries no intent`);
  const plaintext = unsealIntent(keys, request.action, request.intent);
  const digest = intentDigest(plaintext);
  if (request.params[INTENT_PARAM] !== digest) {
    throw new IntentVerificationError("digest_mismatch", "the intent doesn't match the digest the operators approved");
  }
  if (request.operationHash !== operationHash(request.action, request.params)) {
    throw new IntentVerificationError("operation_mismatch", "the request's operation hash doesn't match its params");
  }
  if (request.outcome !== "authorized") {
    throw new IntentVerificationError("not_authorized", `request ${request.id} isn't authorized`);
  }
  let parsed: { v?: unknown; client?: unknown; method?: unknown; args?: unknown };
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new IntentVerificationError("bad_intent", "the intent plaintext isn't JSON");
  }
  if (parsed?.v !== 1 || typeof parsed.client !== "string" || typeof parsed.method !== "string" || !Array.isArray(parsed.args)) {
    throw new IntentVerificationError("bad_intent", "the intent isn't a v1 intent");
  }
  for (const field of Object.keys(parsed)) {
    if (!INTENT_FIELDS.has(field)) throw new IntentVerificationError("bad_intent", `unknown field ${field}`);
  }
  // Keyword arguments come from Python proposers; dropping them would replay a different call.
  const kwargs = (parsed as { kwargs?: unknown }).kwargs;
  if (kwargs !== undefined && (kwargs === null || typeof kwargs !== "object" || Array.isArray(kwargs) || Object.keys(kwargs).length > 0)) {
    throw new IntentVerificationError("bad_intent", "kwargs not supported");
  }
  return {
    v: 1,
    client: parsed.client,
    method: parsed.method,
    args: parsed.args,
    plaintext,
    digest,
    kid: request.intent.kid,
  };
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * The configured keys, first one sealing. Falls back to `OUTIS_INTENT_KEYS` (comma separated),
 * then `OUTIS_INTENT_KEY`, when the process has an environment.
 */
export function resolveIntentKeys(configured: IntentKey | readonly IntentKey[] | undefined): IntentKey[] {
  if (configured !== undefined) {
    const list = typeof configured === "string" || configured instanceof Uint8Array ? [configured] : [...configured];
    list.forEach(parseIntentKey);
    return list;
  }
  const many = env("OUTIS_INTENT_KEYS");
  if (many) return many.split(",").map((k) => k.trim()).filter((k) => k !== "");
  const one = env("OUTIS_INTENT_KEY");
  return one ? [one] : [];
}
