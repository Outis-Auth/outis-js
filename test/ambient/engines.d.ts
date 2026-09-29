// Minimal shapes of third party packages the examples import, so they type-check without installing them.

declare module "stripe" {
  interface TransferParams {
    amount: number;
    currency: string;
    destination: string;
    metadata?: Record<string, string>;
  }
  interface RequestOptions {
    idempotencyKey?: string;
    stripeAccount?: string;
  }
  export default class Stripe {
    constructor(apiKey: string);
    transfers: { create(params: TransferParams, options?: RequestOptions): Promise<{ id: string; amount: number }> };
  }
}

declare module "express" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  interface Request extends IncomingMessage {
    body: any;
  }
  interface Response extends ServerResponse {
    status(code: number): Response;
    json(body: unknown): Response;
  }
  type Handler = (req: Request, res: Response, next: () => void) => unknown;
  interface Application {
    use(handler: Handler): Application;
    post(path: string, ...handlers: Handler[]): Application;
    listen(port: number, cb?: () => void): import("node:http").Server;
  }
  interface Express {
    (): Application;
    raw(options: { type: string }): Handler;
    json(): Handler;
  }
  const express: Express;
  export default express;
}

declare module "@temporalio/workflow" {
  export type Duration = string | number;
  export interface SignalDefinition<Args extends any[] = [], Name extends string = string> {
    type: "signal";
    name: Name;
    __args?: Args;
  }
  export function defineSignal<Args extends any[] = [], Name extends string = string>(name: Name): SignalDefinition<Args, Name>;
  export function setHandler<Args extends any[]>(def: SignalDefinition<Args>, handler: (...args: Args) => void | Promise<void>): void;
  export function condition(fn: () => boolean, timeout: Duration): Promise<boolean>;
  export function condition(fn: () => boolean): Promise<void>;
  export function workflowInfo(): { workflowId: string; runId: string };
  export function proxyActivities<A>(options: { startToCloseTimeout: Duration; retry?: { maximumAttempts?: number } }): {
    [K in keyof A]: A[K] extends (...args: infer P) => infer R ? (...args: P) => Promise<Awaited<R>> : never;
  };
}

declare module "@temporalio/client" {
  import type { SignalDefinition } from "@temporalio/workflow";
  export class Connection {
    static connect(options?: { address?: string }): Promise<Connection>;
  }
  export interface WorkflowHandle {
    signal<Args extends any[]>(def: SignalDefinition<Args> | string, ...args: Args): Promise<void>;
  }
  export class Client {
    constructor(options?: { connection?: Connection; namespace?: string });
    workflow: {
      getHandle(workflowId: string): WorkflowHandle;
      start(workflow: string | ((...args: any[]) => Promise<unknown>), options: { taskQueue: string; workflowId: string; args?: unknown[] }): Promise<WorkflowHandle>;
    };
  }
}

declare module "@temporalio/worker" {
  export class NativeConnection {
    static connect(options?: { address?: string }): Promise<NativeConnection>;
  }
  export class Worker {
    static create(options: {
      connection?: NativeConnection;
      namespace?: string;
      taskQueue: string;
      workflowsPath: string;
      activities: object;
    }): Promise<Worker>;
    run(): Promise<void>;
    shutdown(): void;
  }
}

declare module "inngest" {
  export interface InngestEvent<D = any> {
    id?: string;
    name: string;
    data: D;
  }
  export interface Step {
    run<T>(id: string, fn: () => T | Promise<T>): Promise<Awaited<T>>;
    waitForEvent(
      id: string,
      options: { event: string; timeout: string | number | Date; match?: string; if?: string },
    ): Promise<InngestEvent | null>;
  }
  export class Inngest {
    constructor(options: { id: string; signingKey?: string });
    createFunction<R>(
      config: { id: string; triggers: { event: string } | Array<{ event: string } | { cron: string }> },
      handler: (ctx: { event: InngestEvent; step: Step }) => Promise<R>,
    ): { id: string };
    send(event: { name: string; data: unknown; id?: string }): Promise<{ ids: string[] }>;
  }
}

declare module "inngest/next" {
  export function serve(options: { client: import("inngest").Inngest; functions: unknown[] }): {
    GET: (req: Request) => Promise<Response>;
    POST: (req: Request) => Promise<Response>;
    PUT: (req: Request) => Promise<Response>;
  };
}

declare module "@trigger.dev/sdk" {
  export interface WaitToken {
    id: string;
    url: string;
    isCached: boolean;
    publicAccessToken: string;
  }
  export type WaitResult<T> = ({ ok: true; output: T } | { ok: false; error: Error }) & { unwrap(): T };
  export const wait: {
    createToken(options?: { timeout?: string; idempotencyKey?: string; idempotencyKeyTTL?: string; tags?: string[] }): Promise<WaitToken>;
    forToken<T>(token: string | { id: string }): Promise<WaitResult<T>>;
    completeToken<T>(token: string | { id: string }, output: T): Promise<void>;
    for(options: { seconds?: number; minutes?: number; hours?: number }): Promise<void>;
  };
  export function task<P, R>(options: { id: string; run: (payload: P) => Promise<R> }): { id: string };
}
