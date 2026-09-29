import { RUNTIMES, scaffold, type Runtime } from "./scaffold.js";

const USAGE = `usage: npx @outis/sdk init worker [-runtime ${RUNTIMES.join("|")}]

Writes a runnable worker starter into the current directory. It never overwrites a file.`;

const NEXT_STEPS: Record<Runtime, string> = {
  node: "Run it with OUTIS_API_KEY and OUTIS_INTENT_KEYS set: npx tsx outis-worker.ts",
  next: "Add OUTIS_API_KEY, OUTIS_INTENT_KEYS and OUTIS_WEBHOOK_SECRET, then point an Outis webhook at /api/outis.",
  cloudflare: "Set main = \"outis-worker.ts\" and compatibility_flags = [\"nodejs_compat\"] in wrangler.toml, then wrangler secret put each key.",
  temporal: "Run outis-temporal/worker.ts and outis-temporal/bridge.ts, and point an Outis webhook at the bridge.",
  inngest: "Serve payout from your Inngest route, mount outisWebhook, and point an Outis webhook at it.",
  trigger: "Deploy with the Trigger.dev CLI; the task waits on a token Outis completes through callbackUrl.",
};

function flag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const bare = a.replace(/^-{1,2}/, "");
    if (bare === name) return args[i + 1];
    if (bare.startsWith(`${name}=`)) return bare.slice(name.length + 1);
  }
  return undefined;
}

/** Runs the CLI with `argv` (without node and the script) and resolves with the exit code. */
export async function main(argv: string[], options: { cwd?: string; examples?: string } = {}): Promise<number> {
  const [command, what] = argv;
  if (command !== "init" || what !== "worker" || argv.includes("-h") || argv.includes("-help")) {
    console.error(USAGE);
    return command === undefined || argv.includes("-h") || argv.includes("-help") ? 0 : 2;
  }
  const runtime = (flag(argv.slice(2), "runtime") ?? "node") as Runtime;
  if (!RUNTIMES.includes(runtime)) {
    console.error(`unknown runtime "${runtime}"\n\n${USAGE}`);
    return 2;
  }
  try {
    const written = await scaffold(runtime, options.cwd ?? process.cwd(), options.examples);
    for (const f of written) console.log(`wrote ${f}`);
    console.log(`\n${NEXT_STEPS[runtime]}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
