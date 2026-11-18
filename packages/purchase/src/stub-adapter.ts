/**
 * StubPurchaseAdapter — a labelled placeholder kept for packages/stores that do
 * not yet have a real integration. NOT for demo checkout; every method throws.
 * The real demo path is `CrossmintPurchaseAdapter`.
 */

import type {
  BuildCartInput,
  Cart,
  PlaceOrderInput,
  PreviewResult,
  PurchaseAdapter,
  Receipt,
} from "@gta/core";

const NOT_IMPLEMENTED = "not implemented: StubPurchaseAdapter — use CrossmintPurchaseAdapter for a real checkout";

/** STUB PurchaseAdapter. Not for demo checkout. */
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
