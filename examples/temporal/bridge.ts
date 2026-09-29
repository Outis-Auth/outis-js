// The bridge: a small HTTP service that verifies Outis webhooks and signals the waiting workflow.
// Env: OUTIS_WEBHOOK_SECRET, TEMPORAL_ADDRESS.
import { createServer } from "node:http";
import { Client, Connection } from "@temporalio/client";
import { verifyWebhook, WebhookVerificationError } from "@outis/sdk";
import { outisDecision } from "./workflows.js";

async function main(): Promise<void> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  const temporal = new Client({ connection });

  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try {
      const event = verifyWebhook(Buffer.concat(chunks), req.headers, process.env.OUTIS_WEBHOOK_SECRET!);
      const workflowId = event.data.request.params.workflow_id;
      if (workflowId) {
        await temporal.workflow.getHandle(workflowId).signal(outisDecision, { requestId: event.data.request.id, type: event.type });
      }
      res.writeHead(200).end();
    } catch (err) {
      res.writeHead(err instanceof WebhookVerificationError ? 400 : 500).end();
    }
  }).listen(3000);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
