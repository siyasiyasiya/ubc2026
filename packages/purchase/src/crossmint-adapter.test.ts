/**
 * Adapter tests. We mock ONLY the HTTP seam (`FetchLike`) and let the real
 * CrossmintHttpClient + CrossmintPurchaseAdapter logic run end to end — so
 * cart-building, money conversion, preview totals, receipt mapping and the
 * blocked path are all exercised for real against canned wire responses.
 */

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildCartInput, Cart, CheckoutMethod } from "@gta/core";

import { CrossmintPurchaseAdapter } from "./crossmint-adapter.js";
import { CrossmintHttpClient, type FetchLike, type WireRun } from "./crossmint-client.js";
import { CrossmintBlockedError } from "./errors.js";
import { SummaryCardRenderer, type CheckoutScreenshotRenderer } from "./screenshot.js";

const RUN_ID = "run_abc";
const STORE_CHECKOUT: CheckoutMethod = { kind: "store_account", memberId: "m1", store: "SuperMart" };

interface Recorder {
  calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }>;
  getRunQueue: WireRun[];
}

/** Build a scripted FetchLike. `getRunQueue` is consumed one entry per GET
 *  (the last entry repeats once drained), simulating a run advancing. */
function makeFetch(opts: {
  createRun?: Partial<WireRun>;
  getRunQueue: WireRun[];
  orderIntent?: unknown;
}): { fetch: FetchLike; rec: Recorder } {
  const rec: Recorder = { calls: [], getRunQueue: [...opts.getRunQueue] };
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname.replace("/api/unstable", "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    rec.calls.push({ method, path, body, headers: init?.headers ?? {} });

    let payload: unknown = {};
    if (method === "POST" && path === "/agent-checkouts") {
      payload = { runId: RUN_ID, status: "queued", ...opts.createRun };
    } else if (method === "GET" && path === `/agent-checkouts/${RUN_ID}`) {
      payload = rec.getRunQueue.length > 1 ? rec.getRunQueue.shift() : rec.getRunQueue[0];
    } else if (path === "/order-intents") {
      payload = opts.orderIntent ?? { id: "oi_live_1", rails: [{}] };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetch, rec };
}

function adapter(fetch: FetchLike, renderer?: CheckoutScreenshotRenderer): CrossmintPurchaseAdapter {
  return new CrossmintPurchaseAdapter({
    client: new CrossmintHttpClient({
      apiKey: "sk_test",
      clientApiKey: "ck_test",
      userToken: (userId) => `jwt-for-${userId}`,
      userId: "u1",
      fetch,
    }),
    paymentMethodId: "pm_card_1",
    screenshotRenderer: renderer,
    pollIntervalMs: 0,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
  });
}

const paymentRun = (overrides: Partial<WireRun> = {}): WireRun => ({
  runId: RUN_ID,
  status: "awaiting_input",
  requiredAction: {
    requestId: "req_pay_1",
    interaction: {
      kind: "payment",
      amount: { value: "42.50", currency: "USD" },
      merchant: { id: "merch_9", name: "SuperMart" },
      lineItems: [
        { name: "Paper towels", quantity: 2, unitPrice: { value: "8.00", currency: "USD" } },
        { name: "Dish soap", quantity: 1, amount: { value: "12.50", currency: "USD" } },
      ],
    },
  },
  browser: { embedUrl: "https://www.crossmint.com/embed/run_abc" },
  ...overrides,
});

const BUILD_INPUT: BuildCartInput = {
  requestText: "we're out of paper towels and dish soap",
  items: [
    { name: "paper towels", quantity: 2 },
    { name: "dish soap", quantity: 1 },
  ],
  checkout: STORE_CHECKOUT,
};

afterEach(() => vi.restoreAllMocks());

describe("buildCart", () => {
  it("starts a run and prices the cart from the payment step", async () => {
    const { fetch, rec } = makeFetch({
      getRunQueue: [
        { runId: RUN_ID, status: "running" },
        paymentRun(),
      ],
    });
    const cart = await adapter(fetch).buildCart(BUILD_INPUT);

    // Cart id IS the Crossmint runId, store comes from the store_account method.
    expect(cart.id).toBe(RUN_ID);
    expect(cart.store).toBe("SuperMart");
    expect(cart.checkout).toEqual(STORE_CHECKOUT);

    // Line items priced from the merchant breakdown (strings → micro-USDC).
    expect(cart.lineItems).toEqual([
      { name: "Paper towels", quantity: 2, unitPrice: 8_000_000n },
      { name: "Dish soap", quantity: 1, unitPrice: 12_500_000n },
    ]);
    // subtotal = 2*8 + 12.50 = 28.50; non-item remainder (14.00) recorded as tax.
    expect(cart.subtotal).toBe(28_500_000n);
    expect(cart.tax).toBe(14_000_000n);
    expect(cart.shipping).toBe(0n);
    // total is exactly what Crossmint will charge.
    expect(cart.total).toBe(42_500_000n);

    // The create-run call carried the task + a USD maxCost guardrail.
    const create = rec.calls.find((c) => c.method === "POST" && c.path === "/agent-checkouts");
    expect(create?.body).toMatchObject({
      request: { startUrl: expect.stringContaining("amazon.com/s?k=") },
      constraints: { maxCost: { currency: "USD" } },
    });
  });

  it("throws CrossmintBlockedError when the merchant blocks the checkout", async () => {
    const { fetch } = makeFetch({
      getRunQueue: [
        { runId: RUN_ID, status: "running" },
        {
          runId: RUN_ID,
          status: "blocked",
          result: { code: "merchant.access_blocked", summary: "Merchant blocked automation" },
        },
      ],
    });
    await expect(adapter(fetch).buildCart(BUILD_INPUT)).rejects.toMatchObject({
      name: "CrossmintBlockedError",
      code: "merchant.access_blocked",
      runId: RUN_ID,
    });
  });
});

describe("preview", () => {
  it("renders a screenshot with the real total and re-prices from the run", async () => {
    const { fetch } = makeFetch({ getRunQueue: [paymentRun()] });
    const fakeRenderer: CheckoutScreenshotRenderer = {
      render: vi.fn(async () => ({ uri: "/tmp/shot.svg", mimeType: "image/svg+xml" })),
    };
    const cart: Cart = {
      id: RUN_ID,
      store: "SuperMart",
      lineItems: [{ name: "stale", quantity: 1, unitPrice: 1n as never }],
      subtotal: 1n as never,
      tax: 0n as never,
      shipping: 0n as never,
      total: 1n as never,
      checkout: STORE_CHECKOUT,
    };
    const result = await adapter(fetch, fakeRenderer).preview(cart);

    // Re-priced from the live run, not the stale passed-in cart.
    expect(result.total).toBe(42_500_000n);
    expect(result.cart.total).toBe(42_500_000n);
    expect(result.screenshot.image.uri).toBe("/tmp/shot.svg");
    expect(result.screenshot.caption).toContain("$42.50");
    expect(fakeRenderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ embedUrl: "https://www.crossmint.com/embed/run_abc" }),
    );
  });
});

describe("placeOrder", () => {
  const succeeded: WireRun = {
    runId: RUN_ID,
    status: "succeeded",
    result: {
      outcome: "purchased",
      purchase: {
        kind: "receipt_captured",
        receipt: {
          total: { amount: "42.50", currency: "USD" },
          merchant: { name: "SuperMart" },
          merchantOrderId: "M-1001",
          lineItems: [
            { name: "Paper towels", amount: { amount: "16.00", currency: "USD" } },
            { name: "Dish soap", amount: { amount: "12.50", currency: "USD" } },
          ],
        },
      },
    },
  };

  const cart: Cart = {
    id: RUN_ID,
    store: "SuperMart",
    lineItems: [
      { name: "Paper towels", quantity: 2, unitPrice: 8_000_000n as never },
      { name: "Dish soap", quantity: 1, unitPrice: 12_500_000n as never },
    ],
    subtotal: 28_500_000n as never,
    tax: 14_000_000n as never,
    shipping: 0n as never,
    total: 42_500_000n as never,
    checkout: STORE_CHECKOUT,
  };

  it("authorizes the card, answers the payment request, and maps the receipt", async () => {
    const { fetch, rec } = makeFetch({
      getRunQueue: [paymentRun(), succeeded],
      orderIntent: { id: "oi_live_42" },
    });
    const receipt = await adapter(fetch).placeOrder({ cart });

    expect(receipt.source).toBe("agent_order");
    expect(receipt.merchant).toBe("SuperMart");
    expect(receipt.total).toBe(42_500_000n);
    expect(receipt.at).toBe(1_700_000_000_000);
    expect(receipt.lineItems).toEqual([
      { name: "Paper towels", amount: 16_000_000n },
      { name: "Dish soap", amount: 12_500_000n },
    ]);

    // Order intent used the exact amount + merchant verbatim from the pay request.
    const oi = rec.calls.find((c) => c.path === "/order-intents");
    expect(oi?.body).toMatchObject({
      paymentMethodId: "pm_card_1",
      amount: { value: "42.50", currency: "USD" },
      merchant: { id: "merch_9", name: "SuperMart" },
    });
    // Order intents refuse server keys: client key + the user's JWT.
    expect(oi?.headers).toMatchObject({ "X-API-KEY": "ck_test", Authorization: "Bearer jwt-for-u1" });
    expect(oi?.headers).not.toHaveProperty("x-crossmint-user-id");
    // The payment was answered with that order intent id, as an input_response part.
    const ans = rec.calls.find((c) => c.path.endsWith("/messages"));
    expect(ans?.headers).toMatchObject({ "X-API-KEY": "sk_test" });
    expect(ans?.body).toMatchObject({
      parts: [
        {
          type: "input_response",
          requestId: "req_pay_1",
          action: "submit",
          response: { kind: "payment", orderIntentId: "oi_live_42" },
        },
      ],
    });
  });

  it("uses a pre-approved order intent from checkoutAuth and skips authorization", async () => {
    const { fetch, rec } = makeFetch({ getRunQueue: [paymentRun(), succeeded] });
    await adapter(fetch).placeOrder({ cart, checkoutAuth: "oi_preapproved" });

    expect(rec.calls.find((c) => c.path === "/order-intents")).toBeUndefined();
    const ans = rec.calls.find((c) => c.path.endsWith("/messages"));
    expect(ans?.body).toMatchObject({ parts: [{ response: { kind: "payment", orderIntentId: "oi_preapproved" } }] });
  });

  it("throws CrossmintBlockedError when payment is declined after answering", async () => {
    const { fetch } = makeFetch({
      getRunQueue: [
        paymentRun(),
        { runId: RUN_ID, status: "blocked", result: { code: "merchant.payment_declined" } },
      ],
    });
    await expect(adapter(fetch).placeOrder({ cart })).rejects.toMatchObject({
      name: "CrossmintBlockedError",
      code: "merchant.payment_declined",
    });
  });
});

describe("SummaryCardRenderer", () => {
  it("writes an SVG carrying the real total", async () => {
    const cart: Cart = {
      id: "run_x",
      store: "SuperMart",
      lineItems: [{ name: "Paper towels", quantity: 2, unitPrice: 8_000_000n as never }],
      subtotal: 16_000_000n as never,
      tax: 1_280_000n as never,
      shipping: 0n as never,
      total: 17_280_000n as never,
      checkout: STORE_CHECKOUT,
    };
    const ref = await new SummaryCardRenderer().render({ cart });
    expect(ref.mimeType).toBe("image/svg+xml");
    const svg = await readFile(ref.uri, "utf8");
    expect(svg).toContain("$17.28");
    expect(svg).toContain("Paper towels");
  });
});
