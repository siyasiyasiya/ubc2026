/**
 * @gta/purchase — PurchaseAdapter implementations, one per store.
 *
 * SKELETON. Each adapter builds a cart, previews it (screenshot + final total
 * for the group's 👍), and places a REAL order. The first store and its access
 * method (official agent API vs. browser automation) are UNDECIDED.
 *
 * IMPORTANT: the demo store's adapter must perform a real checkout — do NOT
 * stub placeOrder for anything used in the demo.
 */

import type {
  BuildCartInput,
  Cart,
  PlaceOrderInput,
  PreviewResult,
  PurchaseAdapter,
  Receipt,
} from "@gta/core";

const NOT_IMPLEMENTED = "not implemented: @gta/purchase skeleton — store + access method undecided";

/** STUB PurchaseAdapter. Replace per real store. Not for demo checkout. */
export class StubPurchaseAdapter implements PurchaseAdapter {
  readonly store = "stub";

  async buildCart(_input: BuildCartInput): Promise<Cart> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async preview(_cart: Cart): Promise<PreviewResult> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async placeOrder(_input: PlaceOrderInput): Promise<Receipt> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
