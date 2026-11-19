import path from "node:path";
import { fileURLToPath } from "node:url";
import { usdc, type SpendingLimit } from "@gta/core";

const here = path.dirname(fileURLToPath(import.meta.url));

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** MEMBER_NAMES="+18475551234=Tristan,+16105551234=Siya" */
function names(value: string | undefined): Record<string, string> {
  return Object.fromEntries(
    list(value).flatMap((pair) => {
      const [handle, name] = pair.split("=").map((s) => s.trim());
      return handle && name ? [[handle, name]] : [];
    }),
  );
}

/** MEMBER_WALLETS="+18475551234=0xabc…,+16105551234=0xdef…" until the Face ID join watcher fills this in. */
function wallets(value: string | undefined): Record<string, string> {
  return Object.fromEntries(
    list(value).flatMap((pair) => {
      const [handle, address] = pair.split("=").map((s) => s.trim());
      return handle && address && /^0x[0-9a-fA-F]{40}$/.test(address) ? [[handle, address]] : [];
    }),
  );
}

function hex(value: string | undefined): `0x${string}` | undefined {
  return value && /^0x[0-9a-fA-F]+$/.test(value) ? (value as `0x${string}`) : undefined;
}

const period = process.env.DEFAULT_LIMIT_PERIOD === "monthly" ? "monthly" : "weekly";

export const config = {
  imessageMode: process.env.IMESSAGE_MODE === "cloud" ? ("cloud" as const) : ("local" as const),
  allowedChatIds: list(process.env.ALLOWED_CHAT_IDS),
  names: names(process.env.MEMBER_NAMES),
  wallets: wallets(process.env.MEMBER_WALLETS),
  /** Set both to pull through GroupTreasury on Arc; otherwise the in-memory wallet is used. */
  arc: (() => {
    const operatorPrivateKey = hex(process.env.OPERATOR_PRIVATE_KEY);
    const treasury = hex(process.env.TREASURY_ADDRESS);
    const deployBlock = process.env.TREASURY_DEPLOY_BLOCK ? BigInt(process.env.TREASURY_DEPLOY_BLOCK) : undefined;
    return operatorPrivateKey && treasury
      ? { rpcUrl: process.env.ARC_RPC_URL || undefined, operatorPrivateKey, treasury, ...(deployBlock !== undefined ? { deployBlock } : {}) }
      : undefined;
  })(),
  defaultLimit: {
    amount: usdc(Number(process.env.DEFAULT_LIMIT_USD ?? 200)),
    period,
  } satisfies SpendingLimit,
  /** Face ID invites: tickets are derived from this secret, so keep it out of git and stable. */
  invites: process.env.INVITE_SECRET
    ? { secret: process.env.INVITE_SECRET, baseUrl: process.env.ONBOARD_URL || "https://kittyagent.vercel.app" }
    : undefined,
  /** Where the join watcher starts the first time (the treasury's deploy block). */
  treasuryDeployBlock: process.env.TREASURY_DEPLOY_BLOCK ? BigInt(process.env.TREASURY_DEPLOY_BLOCK) : undefined,
  /** Testnet only: dollars the operator sends each new member so the demo works before they add money. */
  welcomeUsd: Number(process.env.WELCOME_USD ?? 5),
  stateFile: process.env.STATE_FILE ?? path.resolve(here, "../data/state.json"),
};
