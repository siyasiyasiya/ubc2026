/**
 * @gta/wallet — WalletAdapter implementations.
 *
 * SKELETON. The real adapter pulls each member's share from their own wallet
 * to the payer, never exceeding the member's recurring limit. How the limit is
 * enforced is UNDECIDED (on-chain spend permissions vs. a wallet provider's
 * policies vs. signed permits) — hidden behind the WalletAdapter port.
 *
 * A real in-memory adapter (for local dev + driving the state machine without a
 * chain) will land here next, clearly labelled as non-production.
 */

import type { LimitStatus, Member, PullOutcome, PullParams, Usdc, WalletAdapter } from "@gta/core";

const NOT_IMPLEMENTED = "not implemented: @gta/wallet skeleton — chain + provider undecided";

/** STUB WalletAdapter. Replace with in-memory (dev) and on-chain implementations. */
export class StubWalletAdapter implements WalletAdapter {
  readonly id = "stub";

  async getLimitStatus(_member: Member): Promise<LimitStatus> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async canPull(_member: Member, _amount: Usdc): Promise<{ ok: boolean; remaining: Usdc }> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async pull(_params: PullParams): Promise<PullOutcome> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
