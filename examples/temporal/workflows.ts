// Workflow code is deterministic: no SDK calls here, only activities and a signal from the bridge.
import { condition, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type * as activities from "./activities.js";

export interface OutisDecision {
  requestId: string;
  type: string;
}

export const outisDecision = defineSignal<[OutisDecision]>("outisDecision");

const { proposePayout, executeIntent } = proxyActivities<typeof activities>({ startToCloseTimeout: "2 minutes" });

export async function payoutWorkflow(payout: activities.Payout): Promise<string> {
  const decisions = new Map<string, string>();
  setHandler(outisDecision, (d) => void decisions.set(d.requestId, d.type));

  const requestId = await proposePayout(payout, workflowInfo().workflowId);
  await condition(() => decisions.has(requestId), "7 days");

  const decision = decisions.get(requestId);
  if (decision !== undefined && decision !== "request.authorized") return decision;

  // No signal in 7 days still tries once: the claim is the source of truth, and it refuses anything unauthorized.
  const result = await executeIntent(requestId);
  return result.status === "skipped" ? `skipped: ${result.reason}` : result.status;
}
