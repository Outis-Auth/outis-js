import { operationHash } from "../src/index.js";
import { fakeServer, type Fake, type Reply, type Seen } from "./fake.js";

interface Stored {
  wire: Record<string, unknown>;
  claim: { id: string; expires: number } | null;
  reported: string | null;
  failClaims: number;
}

/** A stateful stand-in for the Outis API: requests, decisions, claims and execution reports. */
export class FakeOutis {
  readonly requests = new Map<string, Stored>();
  readonly reports: { id: string; body: Record<string, unknown> }[] = [];
  server!: Fake;
  /** Decides each new request on creation when set. */
  autoOutcome: string | null = null;
  #n = 0;
  #claims = 0;

  static async start(): Promise<FakeOutis> {
    const fake = new FakeOutis();
    fake.server = await fakeServer((req) => fake.#handle(req));
    return fake;
  }

  get url(): string {
    return this.server.url;
  }

  get seen(): Seen[] {
    return this.server.seen;
  }

  decide(id: string, outcome: string): void {
    const s = this.requests.get(id)!;
    s.wire.outcome = outcome;
    s.wire.live = false;
    s.wire.state = outcome === "authorized" ? "succeeded" : outcome;
    s.wire.decided_at = 1788350400000;
    if (outcome === "authorized" && s.wire.intent) (s.wire.execution as Record<string, unknown>).state = "pending";
  }

  #handle(req: Seen): Reply {
    const path = req.path.split("?")[0]!;
    if (req.method === "POST" && path === "/v1/requests") return this.#create(req.body as Record<string, unknown>);
    if (req.method === "GET" && path === "/v1/requests") {
      const list = [...this.requests.values()]
        .filter((s) => s.wire.outcome === "authorized" && s.wire.intent && !s.reported && !s.claim)
        .map((s) => s.wire);
      return { status: 200, body: { requests: list } };
    }
    const m = /^\/v1\/requests\/([^/]+)(?:\/(claim|execution))?$/.exec(path);
    const stored = m ? this.requests.get(decodeURIComponent(m[1]!)) : undefined;
    if (!m || !stored) return { status: 404, body: { error: "no such request", kind: "not_found" } };
    if (!m[2]) return { status: 200, body: { server_now: 1, request: stored.wire } };
    if (m[2] === "claim") {
      if (stored.failClaims > 0) {
        stored.failClaims--;
        return { status: 503, body: { error: "unavailable" } };
      }
      if (stored.reported) return { status: 409, body: { error: "reported", kind: "already_reported" } };
      if (stored.claim) return { status: 409, body: { error: "claimed", kind: "already_claimed" } };
      if (stored.wire.outcome !== "authorized") return { status: 409, body: { error: "no", kind: "not_authorized" } };
      stored.claim = { id: `clm_${++this.#claims}`, expires: 1788351000000 };
      (stored.wire.execution as Record<string, unknown>).state = "claimed";
      return {
        status: 200,
        body: { claim_id: stored.claim.id, lease_expires_at: stored.claim.expires, request: stored.wire },
      };
    }
    const body = req.body as Record<string, unknown>;
    if (!stored.claim || body.claim_id !== stored.claim.id) return { status: 409, body: { error: "not yours", kind: "not_claimed" } };
    stored.reported = body.status as string;
    (stored.wire.execution as Record<string, unknown>).state = body.status;
    this.reports.push({ id: stored.wire.id as string, body });
    return { status: 200, body: { request: stored.wire } };
  }

  #create(body: Record<string, unknown>): Reply {
    const id = `req_${++this.#n}`;
    const params = (body.params ?? {}) as Record<string, string>;
    const wire: Record<string, unknown> = {
      id,
      action: body.action,
      requester: body.requester,
      state: "notified",
      live: true,
      outcome: null,
      approvers: [],
      params,
      operation_hash: operationHash(body.action as string, params),
      created_at: 1788350100000,
      decided_at: null,
      intent: body.intent ?? null,
      execution: { state: "none", execute_by: null },
    };
    this.requests.set(id, { wire, claim: null, reported: null, failClaims: 0 });
    if (this.autoOutcome) this.decide(id, this.autoOutcome);
    return { status: 202, body: { server_now: 1, request: wire } };
  }
}
