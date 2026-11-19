/**
 * CrossmintPurchaseAdapter — a REAL store-checkout adapter built on Crossmint
 * Agent Checkouts (https://docs.crossmint.com/agents/checkouts/overview).
 *
 * One integration buys from any online merchant: Crossmint drives a real
 * browser at the merchant, reaches the pay step, and (once the group approves)
 * charges the buyer's card via an "order intent". Merchants that refuse the
 * automated checkout end the run as `blocked` — surfaced here as
 * `CrossmintBlockedError`.
 *
 * How the PurchaseAdapter methods map onto the run lifecycle
 *   queued → running → awaiting_input(payment) → succeeded | blocked | failed
 *
 *   buildCart : start a run for the requested item(s), poll until the run
 *               reaches the payment step (the real total is now known), and
 *               return a priced core `Cart` whose `id` IS the Crossmint runId.
 *   preview   : re-read the run (re-pricing if the merchant re-quoted) and
 *               render the approval screenshot carrying the real total.
 *   placeOrder: authorize the card via an order intent, answer the run's
 *               payment request, poll to `succeeded`, and map Crossmint's
 *               receipt onto a core `Receipt`. This hits real endpoints — the
 *               order path is never mocked.
 *
 * ── Running a LIVE order ────────────────────────────────────────────────────
 * A real purchase needs a funded Crossmint account and these env vars (see
 * `fromEnv`): CROSSMINT_API_KEY (server key with agent-checkouts.* scopes),
 * CROSSMINT_CLIENT_API_KEY (client key with order-intents.* scopes; order intents refuse
 * server keys), CROSSMINT_JWT_PRIVATE_KEY (Kitty signs the user JWT that goes with it;
 * public key at <ONBOARD_URL>/api/jwks), CROSSMINT_USER_ID, CROSSMINT_PAYMENT_METHOD_ID (a saved
 * card registered for order intents), and optionally CROSSMINT_BUYER_PROFILE_ID
 * / CROSSMINT_BROWSER_PROFILE_ID. All credentials must be LIVE/production — the
 * quickstart notes that mixing test + production keys yields 401. Without a
 * funded key you cannot complete a paid order; the unit tests therefore mock
 * only the HTTP seam (`FetchLike`) and exercise all adapter logic for real.
 */

import {
  addUsdc,
  formatUsdc,
  micros,
  subUsdc,
  type Cart,
  type CartLineItem,
  type CheckoutMethod,
  type Receipt,
  type ReceiptLineItem,
  type Usdc,
} from "@gta/core";
import type { BuildCartInput, PlaceOrderInput, PreviewResult, PurchaseAdapter } from "@gta/core";

import {
  CrossmintHttpClient,
  type CrossmintAgentCheckouts,
  type WireLineItem,
  type WirePaymentInteraction,
  type WireRun,
} from "./crossmint-client.js";
import { CrossmintJwtSigner } from "./crossmint-jwt.js";
import { CrossmintBlockedError, CrossmintCheckoutError, CrossmintConfigError } from "./errors.js";
import { moneyToUsdc, usdcToDecimalString } from "./money-codec.js";
import {
  SummaryCardRenderer,
  type CheckoutScreenshotRenderer,
} from "./screenshot.js";

export interface CrossmintPurchaseAdapterConfig {
  /** The Agent Checkouts API client (the network seam). */
  client: CrossmintAgentCheckouts;
  /** Saved card paymentMethodId used to authorize charges via order intents. */
  paymentMethodId: string;
  /** Optional merchant/buyer account session (the buyer's own store account). */
  buyerProfileId?: string;
  /** Optional persistent browser profile id. */
  browserProfileId?: string;
  /** Spend guardrail per checkout → constraints.maxCost. Default $1,000. */
  maxCost?: Usdc;
  /** Browser session country. Default "US". */
  countryCode?: string;
  /** Label for `adapter.store` / fallback `cart.store`. Default "crossmint". */
  store?: string;
  /** Swappable screenshot renderer. Default renders an SVG summary card. */
  screenshotRenderer?: CheckoutScreenshotRenderer;
  /** Resolve a request into the merchant start URL the agent opens. */
  resolveStartUrl?: (input: BuildCartInput) => string;
  /** Poll cadence while waiting for a run to reach a decision point. Default 1.5s. */
  pollIntervalMs?: number;
  /** Give up waiting after this long. Default 5 min. */
  pollTimeoutMs?: number;
  /** Order-intent validity window. Default 2h. */
  orderIntentTtlMs?: number;
  /** Clock + sleep seams (deterministic tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL = new Set(["succeeded", "blocked", "failed", "cancelled"]);

function isPayment(run: WireRun): run is WireRun & {
  requiredAction: { requestId: string; interaction: WirePaymentInteraction };
} {
  return (
    run.status === "awaiting_input" &&
    run.requiredAction?.interaction?.kind === "payment"
  );
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export class CrossmintPurchaseAdapter implements PurchaseAdapter {
  readonly store: string;

  private readonly cfg: Required<
    Pick<
      CrossmintPurchaseAdapterConfig,
      | "client"
      | "paymentMethodId"
      | "maxCost"
      | "countryCode"
      | "store"
      | "screenshotRenderer"
      | "resolveStartUrl"
      | "pollIntervalMs"
      | "pollTimeoutMs"
      | "orderIntentTtlMs"
      | "now"
      | "sleep"
    >
  > &
    Pick<CrossmintPurchaseAdapterConfig, "buyerProfileId" | "browserProfileId">;

  constructor(config: CrossmintPurchaseAdapterConfig) {
    this.store = config.store ?? "crossmint";
    this.cfg = {
      client: config.client,
      paymentMethodId: config.paymentMethodId,
      buyerProfileId: config.buyerProfileId,
      browserProfileId: config.browserProfileId,
      maxCost: config.maxCost ?? micros(1_000_000_000n), // $1,000
      countryCode: config.countryCode ?? "US",
      store: this.store,
      screenshotRenderer: config.screenshotRenderer ?? new SummaryCardRenderer(),
      resolveStartUrl: config.resolveStartUrl ?? defaultResolveStartUrl,
      pollIntervalMs: config.pollIntervalMs ?? 1_500,
      pollTimeoutMs: config.pollTimeoutMs ?? 5 * 60_000,
      orderIntentTtlMs: config.orderIntentTtlMs ?? 2 * 60 * 60_000,
      now: config.now ?? Date.now,
      sleep: config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  // -- buildCart -------------------------------------------------------------

  async buildCart(input: BuildCartInput): Promise<Cart> {
    const startUrl = this.cfg.resolveStartUrl(input);
    const run = await this.cfg.client.createRun({
      request: { startUrl, task: buildTask(input) },
      constraints: {
        maxCost: { amount: usdcToDecimalString(this.cfg.maxCost), currency: "USD" },
      },
      buyerProfileId: this.cfg.buyerProfileId,
      browser: {
        profileId: this.cfg.browserProfileId,
        location: { type: "country", countryCode: this.cfg.countryCode },
      },
    });

    // Poll until the run reaches the payment step (total known) or stops.
    const settled = await this.waitUntil(run.runId, (r) => isPayment(r) || TERMINAL.has(r.status));
    this.throwIfStopped(settled);
    if (!isPayment(settled)) {
      // Succeeded without a pay gate (nothing to approve) or stuck on a form.
      throw new CrossmintCheckoutError(
        `checkout did not reach an approvable payment step (status=${settled.status}` +
          `${settled.requiredAction ? `, interaction=${settled.requiredAction.interaction.kind}` : ""})`,
        { runId: settled.runId, status: settled.status },
      );
    }

    return this.cartFromPayment(settled, input.checkout, startUrl);
  }

  // -- preview ---------------------------------------------------------------

  async preview(cart: Cart): Promise<PreviewResult> {
    // Re-read the run so a merchant re-quote is reflected before approval.
    let priced = cart;
    let embedUrl: string | undefined;
    try {
      const run = await this.cfg.client.getRun(cart.id);
      embedUrl = run.browser?.embedUrl;
      if (isPayment(run)) priced = this.cartFromPayment(run, cart.checkout, undefined, cart);
    } catch {
      // Preview is best-effort about live state; fall back to the passed cart.
    }

    const image = await this.cfg.screenshotRenderer.render({ cart: priced, embedUrl });
    return {
      screenshot: { image, caption: `${priced.store}, ${formatUsdc(priced.total)}. React 👍 to approve.` },
      total: priced.total,
      cart: priced,
    };
  }

  // -- placeOrder (REAL order) ----------------------------------------------

  async placeOrder(input: PlaceOrderInput): Promise<Receipt> {
    const { cart } = input;
    const run = await this.cfg.client.getRun(cart.id);
    this.throwIfStopped(run);
    if (run.status === "succeeded") return this.receiptFromRun(run, cart); // idempotent re-entry
    if (!isPayment(run)) {
      throw new CrossmintCheckoutError(
        `run ${cart.id} is not awaiting payment (status=${run.status})`,
        { runId: cart.id, status: run.status },
      );
    }

    const pay = run.requiredAction.interaction;
    const requestId = run.requiredAction.requestId;

    // The checkoutAuth may carry a pre-approved order intent (the treasurer's
    // spend approval). Otherwise authorize the configured card up to the exact
    // amount Crossmint asked for, copying its merchant descriptor verbatim.
    const orderIntentId =
      orderIntentIdFromAuth(input.checkoutAuth) ??
      (await this.authorizeCard(pay, cart));

    await this.cfg.client.answerPayment(cart.id, requestId, orderIntentId);

    const done = await this.waitUntil(cart.id, (r) => TERMINAL.has(r.status));
    this.throwIfStopped(done);
    if (done.status !== "succeeded") {
      throw new CrossmintCheckoutError(`order did not complete (status=${done.status})`, {
        runId: cart.id,
        status: done.status,
      });
    }
    return this.receiptFromRun(done, cart);
  }

  // -- internals -------------------------------------------------------------

  private async authorizeCard(pay: WirePaymentInteraction, cart: Cart): Promise<string> {
    const expiresAt = new Date(this.cfg.now() + this.cfg.orderIntentTtlMs).toISOString();
    const intent = await this.cfg.client.createOrderIntent({
      paymentMethodId: this.cfg.paymentMethodId,
      amount: pay.amount, // exact figures from the payment request
      merchant: pay.merchant, // copied unchanged
      expiresAt,
      description: `Group order at ${cart.store} (${formatUsdc(cart.total)})`,
    });
    const id = intent.id ?? intent.orderIntentId;
    if (!id) {
      throw new CrossmintCheckoutError("order intent response had no id", { runId: cart.id });
    }
    // A card rail can come back pending_verification (Visa passkey / Mastercard page) until the
    // card's owner approves it; answering the checkout with it would only fail later, less clearly.
    const statuses = (intent.rails ?? [])
      .map((r) => (r && typeof r === "object" && "status" in r ? String(r.status) : undefined))
      .filter((st): st is string => st !== undefined);
    if (statuses.length > 0 && !statuses.includes("active")) {
      throw new CrossmintCheckoutError(
        `the card needs a one-time verification before Kitty can charge it (${statuses.join(", ")})`,
        { runId: cart.id },
      );
    }
    return id;
  }

  private throwIfStopped(run: WireRun): void {
    if (run.status === "blocked") {
      const code = run.result?.code ?? "merchant.no_safe_path";
      throw new CrossmintBlockedError(run.runId, code, run.result?.summary);
    }
    if (run.status === "failed" || run.status === "cancelled") {
      throw new CrossmintCheckoutError(
        `checkout ${run.status}${run.reason ? `: ${run.reason}` : ""}`,
        { runId: run.runId, status: run.status },
      );
    }
  }

  private async waitUntil(runId: string, done: (r: WireRun) => boolean): Promise<WireRun> {
    const deadline = this.cfg.now() + this.cfg.pollTimeoutMs;
    // First read is immediate; subsequent reads back off by pollIntervalMs.
    for (let first = true; ; first = false) {
      if (!first) await this.cfg.sleep(this.cfg.pollIntervalMs);
      const run = await this.cfg.client.getRun(runId);
      if (done(run)) return run;
      if (this.cfg.now() >= deadline) {
        throw new CrossmintCheckoutError(
          `timed out after ${this.cfg.pollTimeoutMs}ms waiting on run ${runId} (last status=${run.status})`,
          { runId, status: run.status },
        );
      }
    }
  }

  /** Map a payment-step run onto a priced core Cart. The `total` is exactly
   *  what Crossmint will charge; line items come from the merchant's breakdown
   *  when present, else a single summary line. When a breakdown exists, any
   *  non-item remainder (fees/tax/shipping Crossmint didn't itemize) is recorded
   *  as `tax` so subtotal+tax+shipping always equals the real total. */
  private cartFromPayment(
    run: WireRun & { requiredAction: { interaction: WirePaymentInteraction } },
    checkout: CheckoutMethod,
    startUrl?: string,
    prior?: Cart,
  ): Cart {
    const pay = run.requiredAction.interaction;
    const total = moneyToUsdc(pay.amount);

    let lineItems: CartLineItem[];
    if (pay.lineItems && pay.lineItems.length > 0) {
      lineItems = pay.lineItems.map((li) => toCartLineItem(li));
    } else if (prior && prior.lineItems.length > 0) {
      lineItems = prior.lineItems; // keep the richer breakdown from buildCart
    } else {
      lineItems = [{ name: "Order", quantity: 1, unitPrice: total }];
    }

    const subtotal = addUsdc(
      ...lineItems.map((li) => (li.unitPrice * BigInt(li.quantity)) as Usdc),
    );
    const remainder = subUsdc(total, subtotal);
    const tax = remainder > 0n ? remainder : (0n as Usdc);
    const shipping = 0n as Usdc;
    // If line items overshoot the total (discount applied after itemization),
    // collapse to a single accurate line so the cart still sums to `total`.
    if (remainder < 0n) {
      lineItems = [{ name: "Order", quantity: 1, unitPrice: total }];
    }

    const store =
      checkout.kind === "store_account"
        ? checkout.store
        : (startUrl && hostnameOf(startUrl)) ?? prior?.store ?? this.cfg.store;

    return {
      id: run.runId,
      store,
      lineItems,
      subtotal: remainder < 0n ? total : subtotal,
      tax,
      shipping,
      total,
      checkout,
    };
  }

  private receiptFromRun(run: WireRun, cart: Cart): Receipt {
    const receipt = run.result?.purchase?.receipt;
    const total = receipt?.total ? moneyToUsdc(receipt.total) : cart.total;
    const merchant =
      (typeof receipt?.merchant === "string" ? receipt.merchant : receipt?.merchant?.name) ??
      cart.store;

    const lineItems: ReceiptLineItem[] | undefined = receipt?.lineItems
      ? receipt.lineItems.map((li) => ({
          name: li.name ?? li.description ?? "Item",
          amount: li.amount ? moneyToUsdc(li.amount) : (0n as Usdc),
        }))
      : cart.lineItems.map((li) => ({
          name: li.name,
          amount: (li.unitPrice * BigInt(li.quantity)) as Usdc,
        }));

    return {
      source: "agent_order",
      merchant,
      subtotal: cart.subtotal,
      tax: cart.tax,
      total,
      lineItems,
      at: this.cfg.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// Env wiring — construct a live adapter from process.env. See the module
// docstring for the full list of required credentials.
// ---------------------------------------------------------------------------

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new CrossmintConfigError(`missing required env var ${key}`);
  return v;
}

/**
 * Kitty's JWT signer for Crossmint. The issuer defaults to the Face ID page, which also
 * serves the public key at /api/jwks.
 */
export function crossmintJwtSignerFromEnv(env: NodeJS.ProcessEnv = process.env): CrossmintJwtSigner {
  return new CrossmintJwtSigner({
    privateKeyPem: requireEnv(env, "CROSSMINT_JWT_PRIVATE_KEY"),
    kid: env.CROSSMINT_JWT_KID ?? "kitty-1",
    issuer: env.CROSSMINT_JWT_ISSUER ?? env.ONBOARD_URL ?? "https://kittyagent.vercel.app",
    audience: env.CROSSMINT_JWT_AUDIENCE,
  });
}

/** Build a real `CrossmintPurchaseAdapter` from environment variables. */
export function createCrossmintPurchaseAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CrossmintPurchaseAdapterConfig> = {},
): CrossmintPurchaseAdapter {
  const signer = crossmintJwtSignerFromEnv(env);
  const client = new CrossmintHttpClient({
    apiKey: env.CROSSMINT_API_KEY ?? requireEnv(env, "CROSSMINT_SERVER_API_KEY"),
    clientApiKey: requireEnv(env, "CROSSMINT_CLIENT_API_KEY"),
    userToken: (userId) => signer.tokenFor(userId),
    userId: requireEnv(env, "CROSSMINT_USER_ID"),
    baseUrl: env.CROSSMINT_BASE_URL,
  });
  return new CrossmintPurchaseAdapter({
    client,
    paymentMethodId: requireEnv(env, "CROSSMINT_PAYMENT_METHOD_ID"),
    buyerProfileId: env.CROSSMINT_BUYER_PROFILE_ID,
    browserProfileId: env.CROSSMINT_BROWSER_PROFILE_ID,
    store: env.CROSSMINT_STORE_LABEL,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toCartLineItem(li: WireLineItem): CartLineItem {
  const quantity = li.quantity && li.quantity > 0 ? li.quantity : 1;
  const name = li.name ?? li.description ?? "Item";
  if (li.unitPrice) {
    return { name, quantity, unitPrice: moneyToUsdc(li.unitPrice) };
  }
  // Only a line total given: when qty is 1 this is exact; otherwise divide the
  // line total across units (keeps the cart's grand total exact — see caller).
  const lineTotal = li.amount ? moneyToUsdc(li.amount) : (0n as Usdc);
  const unitPrice = quantity === 1 ? lineTotal : (micros(lineTotal / BigInt(quantity)));
  return { name, quantity, unitPrice };
}

function buildTask(input: BuildCartInput): string {
  const items =
    input.items && input.items.length > 0
      ? input.items.map((i) => `${i.quantity ?? 1}× ${i.name}`).join(", ")
      : input.requestText;
  const account =
    input.checkout.kind === "store_account"
      ? ` Use the saved ${input.checkout.store} account.`
      : "";
  return (
    `Buy the following for a group order: ${items}. ` +
    `Pick the best-matching standard option, use standard shipping, and pay by card.` +
    account +
    ` Do not exceed the budget.`
  );
}

/** Default start-URL resolver: use a URL in the request verbatim, else search
 *  Amazon's universal catalog for the requested item(s). Swap via config. */
function defaultResolveStartUrl(input: BuildCartInput): string {
  const text = input.requestText.trim();
  const urlInText = /\bhttps?:\/\/\S+/i.exec(text)?.[0];
  if (urlInText) return urlInText;
  const query =
    input.items && input.items.length > 0
      ? input.items.map((i) => i.name).join(" ")
      : text;
  return `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
}

/** Interpret `PlaceOrderInput.checkoutAuth` as a pre-approved order intent id,
 *  if present (string, or `{ orderIntentId }`). */
function orderIntentIdFromAuth(auth: unknown): string | undefined {
  if (typeof auth === "string" && auth.length > 0) return auth;
  if (auth && typeof auth === "object" && "orderIntentId" in auth) {
    const v = (auth as { orderIntentId?: unknown }).orderIntentId;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
