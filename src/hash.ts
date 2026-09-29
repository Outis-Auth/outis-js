import { createHash } from "node:crypto";

const DOMAIN = "outis.operation.v1\u0000";

/**
 * Fingerprints what a request authorizes: the action and its params, nothing about who asked or when.
 * Matches the server's `operation_hash`, so an executor can recompute it from the operation it's about to run.
 */
export function operationHash(action: string, params: Record<string, string> = {}): string {
  if (typeof action !== "string") throw new TypeError("action must be a string");
  const h = createHash("sha256");
  h.update(DOMAIN, "utf8");
  const write = (s: string) => {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    h.update(len);
    h.update(bytes);
  };
  write(action);
  // Keys sort by their UTF-8 bytes, which differs from JS's UTF-16 order outside the BMP.
  const keys = Object.keys(params)
    .map((k) => ({ k, b: Buffer.from(k, "utf8") }))
    .sort((a, b) => Buffer.compare(a.b, b.b));
  for (const { k } of keys) {
    const v = params[k];
    if (typeof v !== "string") throw new TypeError(`param "${k}" must be a string`);
    write(k);
    write(v);
  }
  return "sha256:" + h.digest("hex");
}
