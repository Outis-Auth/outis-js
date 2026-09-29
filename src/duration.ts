/** A duration: milliseconds as a number, or a string like "500ms", "30s", "5m", "1h", "7d" or "1m30s". */
export type Duration = number | string;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/y;

/** Parses a Duration into milliseconds. Throws a TypeError on anything it can't read. */
export function parseDuration(value: Duration): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`duration must be a non-negative finite number of milliseconds, got ${value}`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new TypeError(`duration must be a number of milliseconds or a string like "5m"`);
  }
  const text = value.trim();
  if (text === "") throw new TypeError(`duration is empty`);
  let total = 0;
  PART.lastIndex = 0;
  while (PART.lastIndex < text.length) {
    const at = PART.lastIndex;
    const match = PART.exec(text);
    if (!match || match.index !== at) {
      throw new TypeError(`can't read duration "${value}"; use forms like "500ms", "30s", "5m", "1h", "7d" or "1m30s"`);
    }
    total += Number(match[1]) * UNIT_MS[match[2] as string]!;
  }
  return total;
}

/** The longest a wait may run. Longer approvals belong with `deferTo` and a worker. */
export const MAX_WAIT_MS = 30 * 60_000;

/** Parses and checks a bounded wait's timeout: required, positive, and at most 30 minutes. */
export function parseWaitTimeout(value: Duration | undefined): number {
  if (value === undefined || value === null) {
    throw new TypeError(
      "timeout is required. Approval can take seconds or days, so pick how long this caller can " +
        "really hold on (at most 30m), or create the request and observe it by webhook or poll",
    );
  }
  const ms = parseDuration(value);
  if (ms <= 0) throw new RangeError("timeout must be greater than zero");
  if (ms > MAX_WAIT_MS) {
    throw new RangeError(
      `timeout ${ms}ms is over the 30m cap for a wait. For anything longer, use guard with deferTo ` +
        "and a worker, or create the request and resume when the webhook arrives",
    );
  }
  return ms;
}
