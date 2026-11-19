/**
 * @gta/purchase — PurchaseAdapter implementations (one per checkout backend).
 *
 * The demo-critical adapter is `CrossmintPurchaseAdapter`, a REAL store-checkout
 * built on Crossmint Agent Checkouts: one integration to buy from any online
 * merchant, pay by the buyer's card, and get a receipt. Blocked merchants are
 * surfaced as `CrossmintBlockedError`.
 *
 * Everything stays behind core's `PurchaseAdapter` interface, so a second
 * adapter (e.g. browser automation) can slot in without touching the core.
 */

export {
  CrossmintPurchaseAdapter,
  createCrossmintPurchaseAdapterFromEnv,
  crossmintJwtSignerFromEnv,
  type BuyerDetails,
  type CrossmintPurchaseAdapterConfig,
} from "./crossmint-adapter.js";

export {
  CrossmintHttpClient,
  type CrossmintAgentCheckouts,
  type CrossmintClientConfig,
  type CreateRunBody,
  type CreateOrderIntentBody,
  type FetchLike,
  type RunStatus,
  type WireRun,
} from "./crossmint-client.js";

export {
  CrossmintBlockedError,
  CrossmintCheckoutError,
  CrossmintConfigError,
  type CrossmintBlockedCode,
} from "./errors.js";

export {
  SummaryCardRenderer,
  type CheckoutScreenshotRenderer,
  type ScreenshotContext,
} from "./screenshot.js";

export {
  moneyToUsdc,
  parseDecimalToUsdc,
  usdcToDecimalString,
  type CrossmintMoney,
} from "./money-codec.js";

export { CrossmintJwtSigner, type CrossmintJwtConfig } from "./crossmint-jwt.js";

export { StubPurchaseAdapter } from "./stub-adapter.js";
