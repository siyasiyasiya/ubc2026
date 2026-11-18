/**
 * @gta/funding — get USDC into a member's wallet.
 *
 * SKELETON. Two paths: add a card (converted to USDC behind the scenes) or
 * connect an existing wallet. Provider is UNDECIDED, so this stays behind a
 * small interface the onboarding flow depends on.
 */

import type { FundingSource, Member } from "@gta/core";

const NOT_IMPLEMENTED = "not implemented: @gta/funding skeleton — provider undecided";

export interface FundingProvider {
  /** Link a card and set up card->USDC conversion for this member. */
  addCard(member: Member, cardToken: string): Promise<FundingSource>;
  /** Connect a wallet the member already controls. */
  connectWallet(member: Member, address: string): Promise<FundingSource>;
}

/** STUB FundingProvider. Replace with the chosen funding provider. */
export class StubFundingProvider implements FundingProvider {
  async addCard(_member: Member, _cardToken: string): Promise<FundingSource> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async connectWallet(_member: Member, _address: string): Promise<FundingSource> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
