// The Temporal worker process: hosts the workflow and the activities. Env: TEMPORAL_ADDRESS, plus the activities' env.
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  const worker = await Worker.create({
    connection,
    taskQueue: "payouts",
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
  });
  process.once("SIGTERM", () => worker.shutdown());
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
