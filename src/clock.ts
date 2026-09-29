/** Time as the client sees it. Swap it in tests so waits don't really wait. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`, or rejects with the signal's reason when it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real clock: `Date.now` and `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
