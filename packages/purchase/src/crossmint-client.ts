/**
 * Crossmint Agent Checkouts — the network layer, isolated so tests can mock
 * ONLY HTTP (the `FetchLike` seam) and exercise all adapter logic for real.
 *
 * This wraps the REST surface the Agent Checkouts quickstart integrates against
 * (the unstable API; there is no server-side SDK — the quickstart's backend
 * calls these endpoints directly):
 *
 *   Base:   https://www.crossmint.com/api/unstable
 *   Auth:   X-API-KEY: <server key>   +   x-crossmint-user-id: <stable user id>
 *
 *   POST /agent-checkouts                      start a checkout run
 *   GET  /agent-checkouts/{runId}              poll status + requiredAction + result
 *   POST /agent-checkouts/{runId}/messages     answer a requiredAction (e.g. pay)
 *   POST /agent-checkouts/{runId}/cancel       cancel a run
 *   POST /order-intents                        authorize a card charge up to an amount
 *
 * Docs: https://docs.crossmint.com/agents/checkouts/overview
 */

// ---------------------------------------------------------------------------
// HTTP seam — the ONLY thing unit tests mock. Typed minimally so this file does
// not depend on the DOM lib for `fetch`/`Response`.
// ---------------------------------------------------------------------------

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

// ---------------------------------------------------------------------------
// Wire types (subset of the Crossmint payloads this adapter depends on).
// ---------------------------------------------------------------------------

export type RunStatus =
  | "pending"
  | "queued"
  | "running"
  | "awaiting_input"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

export interface WireMoney {
  value?: string;
  amount?: string;
  currency?: string;
}

export interface WireLineItem {
  name?: string;
  description?: string;
  quantity?: number;
  amount?: WireMoney;
  unitPrice?: WireMoney;
}

/** A merchant descriptor from a payment request. Treated as opaque — it must be
 *  copied verbatim into the order intent, so we keep the raw value. */
export type WireMerchant = unknown;

export interface WirePaymentInteraction {
  kind: "payment";
  amount: WireMoney;
  merchant?: WireMerchant;
  /** Optional priced breakdown of the checkout, when the merchant exposes one. */
  lineItems?: WireLineItem[];
}

export interface WireFormInteraction {
  kind: "form" | string;
  fields?: Array<{ key: string; label?: string; required?: boolean }>;
}

export type WireInteraction = WirePaymentInteraction | WireFormInteraction;

export interface WireRequiredAction {
  requestId: string;
  interaction: WireInteraction;
}

export interface WireReceipt {
  total?: WireMoney;
  merchant?: { name?: string } | string;
  merchantOrderId?: string;
  lineItems?: WireLineItem[];
}

export interface WireRunResult {
  outcome?: string;
  /** Present when status is `blocked`. */
  code?: string;
  summary?: string;
  purchase?: {
    kind?: "receipt_captured" | "confirmed_without_receipt" | string;
    receipt?: WireReceipt;
  };
}

export interface WireRun {
  runId: string;
  status: RunStatus;
  requiredAction?: WireRequiredAction;
  result?: WireRunResult;
  reason?: string;
  browser?: { embedUrl?: string };
}

export interface CreateRunBody {
  request: { startUrl: string; task: string };
  constraints?: { maxCost?: WireMoney };
  buyerProfileId?: string;
  browser?: { profileId?: string; location?: { type: string; countryCode: string } };
  merchantGuidance?: string;
}

export interface CreateOrderIntentBody {
  paymentMethodId: string;
  amount: WireMoney;
  merchant: WireMerchant;
  expiresAt?: string;
  description?: string;
}

export interface WireOrderIntent {
  id?: string;
  orderIntentId?: string;
  rails?: unknown[];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CrossmintClientConfig {
  /** Server API key with `agent-checkouts.*` + `order-intents` scopes. */
  apiKey: string;
  /** Stable per-user id; MUST match across runs, profiles and order intents. */
  userId: string;
  /** Defaults to https://www.crossmint.com */
  baseUrl?: string;
  /** Injectable fetch. Defaults to the global `fetch`. Tests pass a mock here
   *  — it is the single network seam. */
  fetch?: FetchLike;
}

/**
 * The Agent Checkouts API surface the adapter needs. Declared as an interface
 * so an alternate transport (or a future official SDK) could be dropped in, and
 * so tests can see exactly which calls the adapter makes.
 */
export interface CrossmintAgentCheckouts {
  createRun(body: CreateRunBody): Promise<WireRun>;
  getRun(runId: string): Promise<WireRun>;
  answerPayment(runId: string, requestId: string, orderIntentId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  createOrderIntent(body: CreateOrderIntentBody): Promise<WireOrderIntent>;
}

const DEFAULT_BASE_URL = "https://www.crossmint.com";

export class CrossmintHttpClient implements CrossmintAgentCheckouts {
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: CrossmintClientConfig) {
    this.apiKey = config.apiKey;
    this.userId = config.userId;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const injected = config.fetch;
    if (injected) {
      this.fetchImpl = injected;
    } else if (typeof globalThis.fetch === "function") {
      this.fetchImpl = globalThis.fetch.bind(globalThis) as unknown as FetchLike;
    } else {
      throw new Error("CrossmintHttpClient: no fetch available; pass config.fetch");
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-KEY": this.apiKey,
      "x-crossmint-user-id": this.userId,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/unstable${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Crossmint ${method} ${path} failed (${res.status}): ${raw || "<empty>"}`);
    }
    if (!raw) return undefined as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`Crossmint ${method} ${path}: response was not JSON: ${raw}`);
    }
  }

  createRun(body: CreateRunBody): Promise<WireRun> {
    return this.request<WireRun>("POST", "/agent-checkouts", body);
  }

  getRun(runId: string): Promise<WireRun> {
    return this.request<WireRun>("GET", `/agent-checkouts/${encodeURIComponent(runId)}`);
  }

  async answerPayment(runId: string, requestId: string, orderIntentId: string): Promise<void> {
    await this.request<unknown>("POST", `/agent-checkouts/${encodeURIComponent(runId)}/messages`, {
      id: `msg_${Date.now()}`,
      response: {
        requestId,
        action: "submit",
        answers: { orderIntentId },
      },
    });
  }

  async cancelRun(runId: string): Promise<void> {
    await this.request<unknown>("POST", `/agent-checkouts/${encodeURIComponent(runId)}/cancel`);
  }

  createOrderIntent(body: CreateOrderIntentBody): Promise<WireOrderIntent> {
    return this.request<WireOrderIntent>("POST", "/order-intents", body);
  }
}
