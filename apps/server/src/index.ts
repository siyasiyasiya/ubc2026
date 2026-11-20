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

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClaudeReceiptReader, runTurn, runDmTurn } from "@gta/agent";
import { PhotonChatPort } from "@gta/imessage";
import { createCrossmintPurchaseAdapterFromEnv, crossmintJwtSignerFromEnv } from "@gta/purchase";
import { SimulatedPurchaseAdapter } from "./simulated-purchase.js";
import { elevenLabsFromEnv } from "./restaurant-call.js";
import { usdc, type Usdc } from "@gta/core";
import { getAddress } from "viem";
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

const chat = startChat();
const store = new Store(config.stateFile);
if (config.arc) {
  const cleared = store.useTreasury(config.arc.treasury);
  if (cleared) console.log(`new GroupTreasury ${config.arc.treasury}: cleared ${cleared} account link(s); members rejoin with Face ID`);
  store.save();
}
const runtime = new GroupRuntime({
  chat,
  wallet,
  receipts: new ClaudeReceiptReader(),
  purchase: purchaseAdapter(),
  ...restaurantCalls(),
  runTurn,
  runDmTurn,
  ...testMoney(),
  store,
  defaultLimit: config.defaultLimit,
  names: config.names,
  wallets: config.wallets,
  ...(config.invites ? { invites: config.invites } : {}),
  chats: config.allowedChatIds,
  ...(subscriptionEveryMs() ? { subscriptionEveryMs: subscriptionEveryMs() } : {}),
  ...autoTopUp(),
  ...memberCards(),
});
runtime.attach();
startJoinWatcher();
startReminders();
startSubscriptions();
await chat.start();

/**
 * Proactive reminders: nudge stale approval cards and outstanding debts. Off by default; set
 * NUDGES=on to turn it on (and NUDGE_EVERY_MIN / NUDGE_STALE_HOURS to tune) so it never surprises a demo.
 */
function startReminders(): void {
  if (process.env.NUDGES !== "on") return;
  const everyMs = (Number(process.env.NUDGE_EVERY_MIN) || 60) * 60_000;
  const staleMs = (Number(process.env.NUDGE_STALE_HOURS) || 12) * 60 * 60_000;
  console.log(`nudges: on (every ${everyMs / 60_000} min, cards/debts older than ${staleMs / 3_600_000}h)`);
  setInterval(() => void runtime.run(() => runtime.remind(staleMs)), everyMs).unref?.();
}

/** Demo override: SUBSCRIPTION_EVERY_MIN charges subscriptions every N minutes instead of weekly/monthly. */
function subscriptionEveryMs(): number | undefined {
  const min = Number(process.env.SUBSCRIPTION_EVERY_MIN);
  return min > 0 ? min * 60_000 : undefined;
}

/**
 * Balances match caps (testnet: Kitty sends the difference; real money: a one-tap top-up text),
 * then subscriptions that are due get charged. Top-ups go first so a charge at the start of a
 * period finds the money there. Always on: an approved subscription is a promise to charge.
 */
function startSubscriptions(): void {
  const demo = subscriptionEveryMs();
  const checkMs = demo ? Math.min(60_000, demo) : 5 * 60_000;
  if (demo) console.log(`subscriptions: demo mode, charging every ${demo / 60_000} min`);
  const tick = () =>
    void runtime.run(async () => {
      await runtime.topUpBalances();
      await runtime.chargeSubscriptions();
    });
  tick();
  setInterval(tick, checkMs).unref?.();
}

/**
 * Each member's own card for store buys. Needs the Crossmint client key + JWT key (to open the
 * save-card form as that member), ONBOARD_URL, and BOT_IMESSAGE_ADDRESS (the save page texts the
 * card id back to Kitty there). With CROSSMINT_API_KEY too, buys go on the payer's own card.
 */
function memberCards() {
  const clientKey = process.env.CROSSMINT_CLIENT_API_KEY;
  const bot = process.env.BOT_IMESSAGE_ADDRESS?.trim();
  const base = process.env.ONBOARD_URL?.replace(/\/$/, "");
  if (!clientKey || !process.env.CROSSMINT_JWT_PRIVATE_KEY || !bot || !base) {
    console.log("member cards: off (set CROSSMINT_CLIENT_API_KEY, CROSSMINT_JWT_PRIVATE_KEY, ONBOARD_URL, BOT_IMESSAGE_ADDRESS)");
    return {};
  }
  const signer = crossmintJwtSignerFromEnv();
  // A stable Crossmint user per member that doesn't put their phone number in Crossmint.
  const userIdFor = (handle: string) => `kitty-${createHash("sha256").update(`kitty-card:${handle}`).digest("hex").slice(0, 24)}`;
  const realStore = Boolean(process.env.CROSSMINT_API_KEY || process.env.CROSSMINT_SERVER_API_KEY);
  console.log(`member cards: on${realStore ? ", buys charge the payer's own card" : " (saving only; buys use the simulated store)"}`);
  return {
    cards: {
      userIdFor,
      // In the hash, so neither the key nor the token reaches Vercel's logs. Short params first, so a
      // link cut off in transit still shows the right "didn't come through whole" page.
      linkFor: (handle: string, name: string) =>
        `${base}/card.html#${new URLSearchParams({ b: bot, n: name, k: clientKey, t: signer.tokenFor(userIdFor(handle)) })}`,
      ...(realStore ? { purchaseFor: (card: { userId: string; paymentMethodId: string }) => createCrossmintPurchaseAdapterFromEnv(process.env, {}, card) } : {}),
    },
  };
}

/** AUTO_TOPUP=off turns it off. On testnet Kitty sends the money (AUTO_TOPUP_DAILY_USD per account, default 300). */
function autoTopUp() {
  if (process.env.AUTO_TOPUP === "off") return {};
  const send = testMoney().testMoney?.send;
  if (send) {
    const dailyUsd = Number(process.env.AUTO_TOPUP_DAILY_USD ?? 300);
    console.log(`auto top-up: on (balance kept equal to what the kitties can take; up to $${dailyUsd} per account a day)`);
    return { autoTopUp: { mode: "send" as const, send, dailyUsd } };
  }
  return config.invites ? { autoTopUp: { mode: "remind" as const } } : {};
}

/** Build the iMessage chat port, turning a raw chat.db access failure into a clear, actionable fix. */
function startChat(): PhotonChatPort {
  try {
    return new PhotonChatPort({
      mode: config.imessageMode,
      allowedChatIds: config.allowedChatIds,
      ...(config.selfHandle ? { selfHandle: config.selfHandle } : {}),
    });
  } catch (err) {
    if (!isChatDbAccessError(err)) throw err;
    console.error(
      "\n❌ Can't read Messages (chat.db). This process doesn't have Full Disk Access.\n" +
        "   Grant it to the app running this (VS Code, Terminal, or the `claude` CLI), then restart that app:\n" +
        "   System Settings, Privacy & Security, Full Disk Access.\n" +
        "   Easiest: run this from a VS Code integrated terminal, which usually already has it.\n" +
        "   The demo simulator needs no access: pnpm --filter @gta/server sim\n",
    );
    process.exit(1);
  }
}

/** The imessage-kit / better-sqlite3 failure to open chat.db (missing Full Disk Access on this process). */
function isChatDbAccessError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: { code?: string } };
  const text = `${e?.code ?? ""} ${e?.message ?? ""} ${e?.cause?.code ?? ""}`;
  return /DATABASE|SQLITE_CANTOPEN|unable to open database/i.test(text);
}

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

/** ElevenLabs voice calls to restaurants, when ELEVENLABS_API_KEY and _AGENT_ID are set (by phone with _PHONE_NUMBER_ID, else by link). */
function restaurantCalls() {
  const calls = elevenLabsFromEnv();
  const how = process.env.ELEVENLABS_PHONE_NUMBER_ID ? "phone calls" : "texts the restaurant a link to talk (no ELEVENLABS_PHONE_NUMBER_ID)";
  console.log(calls ? `calls: ElevenLabs voice agent, ${how}` : "calls: off (set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID; ELEVENLABS_PHONE_NUMBER_ID for real phone calls)");
  return calls ? { calls } : {};
}

/**
 * Testnet only: members text Kitty "add $20" and get test dollars from the operator's wallet (top
 * it up at faucet.circle.com). On unless TESTNET_TOPUP=off; capped per request and per day.
 */
function testMoney() {
  if (!config.arc || process.env.TESTNET_TOPUP === "off") return {};
  const { publicClient, walletClient } = arcClients(config.arc);
  const maxUsd = Number(process.env.TESTNET_TOPUP_MAX_USD ?? 20);
  const dailyUsd = Number(process.env.TESTNET_TOPUP_DAILY_USD ?? 50);
  console.log(`test money: on (text Kitty "add $20"; up to $${maxUsd} a request, $${dailyUsd} a day)`);
  return {
    testMoney: {
      send: (address: string, amount: Usdc) => sendWelcomeBalance(walletClient, publicClient, getAddress(address), amount),
      maxUsd,
      dailyUsd,
    },
  };
}
