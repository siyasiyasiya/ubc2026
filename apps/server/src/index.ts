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

import fs from "node:fs";
import path from "node:path";
import { ClaudeReceiptReader, runTurn, runDmTurn } from "@gta/agent";
import { PhotonChatPort } from "@gta/imessage";
import { createCrossmintPurchaseAdapterFromEnv } from "@gta/purchase";
import { SimulatedPurchaseAdapter } from "./simulated-purchase.js";
import { elevenLabsFromEnv } from "./restaurant-call.js";
import { usdc } from "@gta/core";
import { arcClients, arcWalletAdapters, InMemoryWalletAdapter, JoinWatcher, sendWelcomeBalance } from "@gta/wallet";
import { config, warnIfNoClaudeAuth } from "./config.js";
import { GroupRuntime } from "./runtime.js";
import { Store } from "./store.js";

claimSingleInstance(`${config.stateFile}.pid`);
warnIfNoClaudeAuth();

if (config.allowedChatIds.length === 0) {
  console.log("ALLOWED_CHAT_IDS is empty, so the bot auto-serves every group chat its Apple ID is in.");
}

const wallet = config.arc ? arcWalletAdapters(config.arc) : new InMemoryWalletAdapter();
console.log(
  config.arc
    ? `wallet: Arc GroupTreasury ${config.arc.treasury} (${Object.keys(config.wallets).length} member wallets configured)`
    : "wallet: in-memory (set TREASURY_ADDRESS and OPERATOR_PRIVATE_KEY to use Arc)",
);

const chat = new PhotonChatPort({
  mode: config.imessageMode,
  allowedChatIds: config.allowedChatIds,
  ...(config.selfHandle ? { selfHandle: config.selfHandle } : {}),
});
const store = new Store(config.stateFile);
const runtime = new GroupRuntime({
  chat,
  wallet,
  receipts: new ClaudeReceiptReader(),
  purchase: purchaseAdapter(),
  ...restaurantCalls(),
  runTurn,
  runDmTurn,
  store,
  defaultLimit: config.defaultLimit,
  names: config.names,
  wallets: config.wallets,
  ...(config.invites ? { invites: config.invites } : {}),
  chats: config.allowedChatIds,
});
runtime.attach();
startJoinWatcher();
await chat.start();

/**
 * Watches GroupTreasury for Face ID joins (links each member's Kitty account to their handle and,
 * testnet only, sends a welcome balance), limit changes, and debts paid back. Needs the Arc settings and INVITE_SECRET.
 */
function startJoinWatcher(): void {
  if (!config.arc || !config.invites) {
    console.log("join watcher: off (needs TREASURY_ADDRESS, OPERATOR_PRIVATE_KEY and INVITE_SECRET)");
    return;
  }
  const { publicClient, walletClient: operator } = arcClients(config.arc);
  const welcome = usdc(config.welcomeUsd);

  const start = async (): Promise<void> => {
    try {
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
        // `run` passes errors back, so a failed join stops the cursor and the window is retried.
        onJoin: async (event) => {
          const joined = await runtime.run(() => runtime.handleJoin(event));
          if (joined) void welcomeIfNew(event.account);
        },
        onLimitSet: (event) => runtime.run(() => runtime.handleLimitSet(event)),
        onDebtPaid: (event) => runtime.run(() => runtime.handleDebtPaid(event)),
      });
      console.log(`join watcher: scanning from block ${fromBlock}`);
      watcher.start();
    } catch (err) {
      console.log(`join watcher: couldn't start (${(err as Error).message?.split("\n")[0]}), retrying in 10s`);
      setTimeout(() => void start(), 10_000);
    }
  };

  /** Testnet only. Outside the runtime queue so chats don't wait on a confirmation. Once per account. */
  const welcomeIfNew = async (account: `0x${string}`): Promise<void> => {
    if (welcome <= 0n || store.hasWelcomed(account)) return;
    store.markWelcomed(account);
    store.save();
    try {
      const tx = await sendWelcomeBalance(operator, publicClient, account, welcome);
      console.log(`[join] sent ${config.welcomeUsd} test dollars to ${account} (${tx})`);
    } catch (err) {
      store.markWelcomed(account, false);
      store.save();
      console.log(`[join] welcome balance to ${account} failed: ${(err as Error).message?.split("\n")[0]}`);
    }
  };

  void start();
}

/**
 * Refuses to start while another bot is running on the same state file. Two bots on one Messages
 * account reply twice, race on the state file and double the RPC load (five once piled up on Nov 18).
 */
function claimSingleInstance(lockFile: string): void {
  try {
    const pid = Number(fs.readFileSync(lockFile, "utf8"));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if that process is gone, i.e. a stale lock
      console.error(`Another bot is already running (pid ${pid}). Stop it first: kill ${pid}`);
      process.exit(1);
    }
  } catch {
    // No lock, or a stale one: take it.
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.unlinkSync(lockFile);
    } catch {
      // Already gone.
    }
  };
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
}

/**
 * Kitty buys things with Crossmint when its keys are set (a real store order, paid by the payer's
 * saved card); otherwise with a simulated store that says so wherever it shows.
 */
function purchaseAdapter() {
  if (process.env.CROSSMINT_API_KEY || process.env.CROSSMINT_SERVER_API_KEY) {
    const crossmint = createCrossmintPurchaseAdapterFromEnv();
    console.log(`purchase: Crossmint Agent Checkouts (${crossmint.store})`);
    return crossmint;
  }
  console.log("purchase: simulated store (set CROSSMINT_API_KEY for real orders)");
  return new SimulatedPurchaseAdapter();
}

/** ElevenLabs voice calls to restaurants, when ELEVENLABS_API_KEY, _AGENT_ID and _PHONE_NUMBER_ID are set. */
function restaurantCalls() {
  const calls = elevenLabsFromEnv();
  console.log(calls ? "calls: ElevenLabs voice agent" : "calls: off (set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID)");
  return calls ? { calls } : {};
}
