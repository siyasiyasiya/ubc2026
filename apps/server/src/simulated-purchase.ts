/**
 * SimulatedPurchaseAdapter: the "Kitty buys it" flow without a real store order.
 *
 * Used when no Crossmint credentials are set (PURCHASE_MODE=simulated, the default then). Every
 * step the group sees is real (the checkout card, the 👍s, the shares pulled on Arc to whoever's
 * card paid), but no store order is placed and no card is charged. The store is named
 * "(simulated)" everywhere it shows, so nobody mistakes it for a real purchase.
 */

import { randomUUID } from "node:crypto";
import {
  addUsdc,
  micros,
  usdc,
  type BuildCartInput,
  type Cart,
  type PlaceOrderInput,
  type PreviewResult,
  type PurchaseAdapter,
  type Receipt,
  type Usdc,
} from "@gta/core";
import { SummaryCardRenderer, type CheckoutScreenshotRenderer } from "@gta/purchase";

export class SimulatedPurchaseAdapter implements PurchaseAdapter {
  readonly store = "Demo store (simulated)";

  constructor(private readonly renderer: CheckoutScreenshotRenderer = new SummaryCardRenderer()) {}

  async buildCart(input: BuildCartInput): Promise<Cart> {
    const items = input.items?.length ? input.items : [{ name: input.requestText }];
    const lineItems = items.map((item) => ({
      name: item.name,
      quantity: item.quantity ?? 1,
      unitPrice: usdc(item.estimateUsd ?? 0),
    }));
    const missing = lineItems.filter((l) => l.unitPrice === 0n).map((l) => l.name);
    if (missing.length) throw new Error(`the simulated store needs a price for: ${missing.join(", ")}`);
    const subtotal = lineItems.reduce<Usdc>((sum, l) => addUsdc(sum, micros(l.unitPrice * BigInt(l.quantity))), micros(0));
    return {
      id: `sim-${randomUUID()}`,
      store: this.store,
      lineItems,
      subtotal,
      tax: micros(0),
      shipping: micros(0),
      total: subtotal,
      checkout: input.checkout,
    };
  }

  async preview(cart: Cart): Promise<PreviewResult> {
    const image = await this.renderer.render({ cart });
    return { screenshot: { image, caption: `${cart.store} checkout` }, total: cart.total, cart };
  }

  async placeOrder(input: PlaceOrderInput): Promise<Receipt> {
    const { cart } = input;
    return {
      source: "agent_order",
      merchant: cart.store,
      subtotal: cart.subtotal,
      tax: cart.tax,
      total: cart.total,
      lineItems: cart.lineItems.map((l) => ({ name: l.name, amount: micros(l.unitPrice * BigInt(l.quantity)) })),
      at: Date.now(),
    };
  }
}
