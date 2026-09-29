import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "../src/index.js";

export interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Fake {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

/** An HTTP server that answers each call with whatever `handle` returns. */
export async function fakeServer(handle: (req: Seen, n: number) => Reply): Promise<Fake> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const call: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(call);
      const reply = handle(call, seen.length);
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A clock whose sleep advances time instantly. */
export class FakeClock implements Clock {
  t = 1_790_000_000_000;
  sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.sleeps.push(ms);
    this.t += ms;
  }
}

/** The read body's request object, snake_case as the API sends it. */
export function wireRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  const outcome = over.outcome ?? null;
  return {
    id: "req-1",
    action: "deploy.production",
    requester: "keith",
    state: outcome === null ? "notified" : outcome === "authorized" ? "succeeded" : outcome,
    live: outcome === null,
    outcome,
    approvers: outcome === "authorized" ? ["maya", "sam"] : [],
    params: { repo: "acme/payments-api", env: "production", sha: "8d93f71" },
    operation_hash: "sha256:54feb247e0ae56c01d430beb1b1c4c604384ca91832a1ccb435fe2753fb2be9e",
    created_at: 1788350100000,
    decided_at: outcome === null ? null : 1788350400000,
    ...over,
  };
}

export function envelope(over: Record<string, unknown> = {}): { server_now: number; request: unknown } {
  return { server_now: 1788350400000, request: wireRequest(over) };
}
