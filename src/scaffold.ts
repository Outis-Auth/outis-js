import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The runtimes `init worker` has a starter for. */
export const RUNTIMES = ["node", "next", "cloudflare", "temporal", "inngest", "trigger"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** Each runtime's starter: an example shipped in the package, and where it lands in your project. */
const STARTERS: Record<Runtime, { from: string; to: string }[]> = {
  node: [{ from: "background-worker.ts", to: "outis-worker.ts" }],
  next: [{ from: "next-route.ts", to: "app/api/outis/route.ts" }],
  cloudflare: [{ from: "cloudflare-worker.ts", to: "outis-worker.ts" }],
  temporal: ["activities.ts", "workflows.ts", "bridge.ts", "worker.ts"].map((f) => ({
    from: `temporal/${f}`,
    to: `outis-temporal/${f}`,
  })),
  inngest: [{ from: "inngest.ts", to: "outis-inngest.ts" }],
  trigger: [{ from: "trigger.ts", to: "trigger/outis-payout.ts" }],
};

/** Where the package's examples live, next to `dist`. */
export function examplesDir(): string {
  return fileURLToPath(new URL("../examples/", import.meta.url));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes a runtime's starter files under `into`. Refuses, writing nothing, when any of them exists. */
export async function scaffold(runtime: Runtime, into: string, from: string = examplesDir()): Promise<string[]> {
  const files = STARTERS[runtime];
  if (!files) throw new TypeError(`unknown runtime "${runtime}"; pick one of ${RUNTIMES.join(", ")}`);
  const taken: string[] = [];
  for (const f of files) if (await exists(join(into, f.to))) taken.push(f.to);
  if (taken.length > 0) throw new Error(`refusing to overwrite ${taken.join(", ")}`);
  for (const f of files) {
    const target = join(into, f.to);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(from, f.from), "utf8"), { flag: "wx" });
  }
  return files.map((f) => f.to);
}
