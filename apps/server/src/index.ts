/**
 * @gta/server — composition root.
 *
 * SKELETON. This is where concrete adapters get wired into the core state
 * machine and the agent loop runs:
 *
 *   chat (ChatPort)      ─┐
 *   purchase (Purchase)   ├─> agent ─> transition(state, event) ─> effects ─┐
 *   wallet (WalletAdapter)┘                                                  │
 *         ^───────────────── perform effects via the ports ──────────────────┘
 *
 * Each adapter below is a clearly-labelled STUB until its decision is made.
 */

import { StubPurchaseAdapter } from "@gta/purchase";
import { StubWalletAdapter } from "@gta/wallet";
import { PhotonChatPort } from "@gta/imessage";

function main(): void {
  // Adapters (all stubs for now — see each package's TODO).
  const chat = new PhotonChatPort();
  const purchase = new StubPurchaseAdapter();
  const wallet = new StubWalletAdapter();

  // Keep references so unused-stub wiring is explicit, not accidental.
  void chat;
  void purchase;
  void wallet;

  console.log(
    [
      "@gta/server: composition root not wired yet.",
      "TODO: subscribe to ChatPort events, run the agent, drive the state machine,",
      "      perform effects (post_preview, place_order, pull_shares) via the ports.",
    ].join("\n"),
  );
}

main();
