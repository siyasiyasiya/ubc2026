/**
 * @gta/server — composition root. Wires the adapters into the runtime and runs the bot.
 *
 *   pnpm --filter @gta/server dev     (reads apps/server/.env)
 *
 * Adapters:
 *   chat     PhotonChatPort (local Messages.app by default; see @gta/imessage)
 *   agent    Claude via @gta/agent (needs ANTHROPIC_API_KEY)
 *   receipts ClaudeReceiptReader
 *   wallet   ArcWalletAdapter per chat (GroupTreasury on Arc) when TREASURY_ADDRESS and
 *            OPERATOR_PRIVATE_KEY are set; otherwise InMemoryWalletAdapter (not production)
 *   purchase not wired yet (pay-before flow)
 */

import { ClaudeReceiptReader, runTurn } from "@gta/agent";
import { PhotonChatPort } from "@gta/imessage";
import { arcWalletAdapters, InMemoryWalletAdapter } from "@gta/wallet";
import { config } from "./config.js";
import { GroupRuntime } from "./runtime.js";
import { Store } from "./store.js";

if (config.allowedChatIds.length === 0) {
  console.warn(
    "ALLOWED_CHAT_IDS is empty, so the bot will ignore every chat. Send a message containing #treasury in your test group to see its id.",
  );
}

const wallet = config.arc ? arcWalletAdapters(config.arc) : new InMemoryWalletAdapter();
console.log(
  config.arc
    ? `wallet: Arc GroupTreasury ${config.arc.treasury} (${Object.keys(config.wallets).length} member wallets configured)`
    : "wallet: in-memory (set TREASURY_ADDRESS and OPERATOR_PRIVATE_KEY to use Arc)",
);

const chat = new PhotonChatPort({ mode: config.imessageMode, allowedChatIds: config.allowedChatIds });
const runtime = new GroupRuntime({
  chat,
  wallet,
  receipts: new ClaudeReceiptReader(),
  runTurn,
  store: new Store(config.stateFile),
  defaultLimit: config.defaultLimit,
  names: config.names,
  wallets: config.wallets,
});
runtime.attach();
await chat.start();
