/**
 * @gta/server — composition root. Wires the adapters into the runtime and runs the bot.
 *
 *   pnpm --filter @gta/server dev     (reads apps/server/.env)
 *
 * Adapters:
 *   chat     PhotonChatPort (local Messages.app by default; see @gta/imessage)
 *   agent    Claude via @gta/agent (needs ANTHROPIC_API_KEY)
 *   receipts ClaudeReceiptReader
 *   wallet   InMemoryWalletAdapter (not production; swap for the Arc contract adapter)
 *   purchase not wired yet (pay-before flow)
 */

import { ClaudeReceiptReader, runTurn } from "@gta/agent";
import { PhotonChatPort } from "@gta/imessage";
import { InMemoryWalletAdapter } from "@gta/wallet";
import { config } from "./config.js";
import { GroupRuntime } from "./runtime.js";
import { Store } from "./store.js";

if (config.allowedChatIds.length === 0) {
  console.warn(
    "ALLOWED_CHAT_IDS is empty, so the bot will ignore every chat. Send a message containing #treasury in your test group to see its id.",
  );
}

const chat = new PhotonChatPort({ mode: config.imessageMode, allowedChatIds: config.allowedChatIds });
const runtime = new GroupRuntime({
  chat,
  wallet: new InMemoryWalletAdapter(),
  receipts: new ClaudeReceiptReader(),
  runTurn,
  store: new Store(config.stateFile),
  defaultLimit: config.defaultLimit,
  names: config.names,
});
runtime.attach();
await chat.start();
