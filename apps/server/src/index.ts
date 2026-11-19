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
import { usdc } from "@gta/core";
import { arcClients, arcWalletAdapters, InMemoryWalletAdapter, JoinWatcher, sendWelcomeBalance } from "@gta/wallet";
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
const store = new Store(config.stateFile);
const runtime = new GroupRuntime({
  chat,
  wallet,
  receipts: new ClaudeReceiptReader(),
  runTurn,
  store,
  defaultLimit: config.defaultLimit,
  names: config.names,
  wallets: config.wallets,
  ...(config.invites ? { invites: config.invites } : {}),
});
runtime.attach();
startJoinWatcher();
await chat.start();

/**
 * Watches GroupTreasury for Face ID joins, links each member's Kitty account to their handle, and
 * (testnet only) sends them a welcome balance. Needs the Arc settings and INVITE_SECRET.
 */
function startJoinWatcher(): void {
  if (!config.arc || !config.invites) {
    console.log("join watcher: off (needs TREASURY_ADDRESS, OPERATOR_PRIVATE_KEY and INVITE_SECRET)");
    return;
  }
  const { publicClient, walletClient: operator } = arcClients(config.arc);
  const welcome = usdc(config.welcomeUsd);

  void (async () => {
    const fromBlock = store.joinCursor ?? config.treasuryDeployBlock ?? (await publicClient.getBlockNumber());
    const watcher = new JoinWatcher({
      publicClient,
      treasury: config.arc!.treasury,
      fromBlock,
      log: (line) => console.log(`[join] ${line}`),
      onCursor: (next) => {
        store.joinCursor = next;
        store.save();
      },
      onJoin: (event) =>
        runtime.serial(async () => {
          const joined = await runtime.handleJoin(event);
          if (!joined || welcome <= 0n) return;
          // Only top up an empty account, so rejoining or a replayed event doesn't pay twice.
          if ((await publicClient.getBalance({ address: event.account })) > 0n) return;
          const tx = await sendWelcomeBalance(operator, publicClient, event.account, welcome);
          console.log(`[join] sent ${config.welcomeUsd} test dollars to ${event.account} (${tx})`);
        }),
    });
    console.log(`join watcher: scanning from block ${fromBlock}`);
    watcher.start();
  })();
}
