import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { main } from "../src/cli.js";
import { RUNTIMES, scaffold } from "../src/scaffold.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const examples = join(root, "examples");
const temps: string[] = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "outis-init-"));
  temps.push(dir);
  return dir;
}

test("every runtime's starter type-checks against this package", { timeout: 120_000 }, async () => {
  const dir = await temp();
  for (const runtime of RUNTIMES) await scaffold(runtime, join(dir, runtime), examples);
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        typeRoots: [join(root, "node_modules/@types")],
        types: ["node"],
        paths: { "@outis/sdk": [join(root, "src/index.ts")], "@outis/sdk/recipes": [join(root, "src/recipes.ts")] },
      },
      include: ["**/*.ts", join(root, "test/ambient/*.d.ts")],
    }),
  );
  const tsc = join(root, "node_modules/typescript/bin/tsc");
  try {
    await promisify(execFile)(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")]);
  } catch (err) {
    assert.fail(`the starters don't type-check:\n${(err as { stdout?: string }).stdout ?? err}`);
  }
});

test("init writes the starter and refuses to overwrite anything", async () => {
  const dir = await temp();
  const written = await scaffold("temporal", dir, examples);
  assert.deepEqual(written, [
    "outis-temporal/activities.ts",
    "outis-temporal/workflows.ts",
    "outis-temporal/bridge.ts",
    "outis-temporal/worker.ts",
  ]);
  assert.equal(
    await readFile(join(dir, "outis-temporal/workflows.ts"), "utf8"),
    await readFile(join(examples, "temporal/workflows.ts"), "utf8"),
  );
  await writeFile(join(dir, "outis-temporal/bridge.ts"), "mine");
  await rm(join(dir, "outis-temporal/worker.ts"));
  await assert.rejects(scaffold("temporal", dir, examples), /refusing to overwrite outis-temporal\/activities\.ts/);
  assert.equal(await readFile(join(dir, "outis-temporal/bridge.ts"), "utf8"), "mine");
});

test("the CLI reads its flags and exits non-zero on a bad runtime or a collision", async () => {
  const dir = await temp();
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    assert.equal(await main(["init", "worker", "-runtime", "next"], { cwd: dir, examples }), 0);
    await readFile(join(dir, "app/api/outis/route.ts"), "utf8");
    assert.equal(await main(["init", "worker", "-runtime=next"], { cwd: dir, examples }), 1);
    assert.equal(await main(["init", "worker", "-runtime", "rails"], { cwd: dir, examples }), 2);
    assert.equal(await main(["init", "worker"], { cwd: dir, examples }), 0);
    await readFile(join(dir, "outis-worker.ts"), "utf8");
    assert.equal(await main(["deploy"], { cwd: dir, examples }), 2);
  } finally {
    console.log = quiet.log;
    console.error = quiet.error;
  }
});
