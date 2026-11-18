/**
 * Typed errors for the Crossmint purchase adapter. The `blocked` case is a
 * first-class, expected outcome (a merchant refused the automated checkout), so
 * it gets its own error type carrying Crossmint's machine-readable code.
 */

/** Crossmint's documented `blocked` run codes. A blocked run stopped SAFELY
 *  before any purchase was made. */
export type CrossmintBlockedCode =
  | "policy.max_cost_exceeded"
  | "product.item_unavailable"
  | "product.requested_option_unavailable"
  | "merchant.fulfillment_unavailable"
  | "merchant.human_verification_required"
  | "merchant.access_blocked"
  | "merchant.payment_declined"
  | "merchant.checkout_error"
  | "merchant.no_safe_path"
  // Keep the type open: Crossmint may add codes we don't want to crash on.
  | (string & {});

/** Thrown when a Crossmint checkout ends in `blocked` — the merchant (or a
 *  policy guardrail) stopped the run before completing the purchase. No charge
 *  was made. Callers should surface `code`/`summary` to the group chat. */
export class CrossmintBlockedError extends Error {
  readonly code: CrossmintBlockedCode;
  readonly runId: string;
  readonly summary?: string;

  constructor(runId: string, code: CrossmintBlockedCode, summary?: string) {
    super(`Crossmint checkout blocked (${code})${summary ? `: ${summary}` : ""}`);
    this.name = "CrossmintBlockedError";
    this.code = code;
    this.runId = runId;
    this.summary = summary;
  }
}

/** Thrown when a run ends in `failed`/`cancelled`, or an API call errors. */
export class CrossmintCheckoutError extends Error {
  readonly runId?: string;
  readonly status?: string;

  constructor(message: string, opts: { runId?: string; status?: string } = {}) {
    super(message);
    this.name = "CrossmintCheckoutError";
    this.runId = opts.runId;
    this.status = opts.status;
  }
}

/** Thrown when required configuration/credentials are missing. */
export class CrossmintConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossmintConfigError";
  }
}
