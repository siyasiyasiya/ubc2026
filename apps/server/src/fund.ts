/**
 * Testnet: send test dollars from the operator's wallet to a member, for the team to test with.
 *
 *   pnpm --filter @gta/server fund <phone|address> <usd>
 *
 * A phone number is looked up in the bot's state (it must have joined through Face ID).
 */

import { usdc } from "@gta/core";
import { arcClients, sendWelcomeBalance } from "@gta/wallet";
import { getAddress, isAddress } from "viem";
import { config } from "./config.js";
import { Store } from "./store.js";

const [who, amount] = process.argv.slice(2);
const usd = Number(amount);
if (!who || !(usd > 0)) {
  console.error("usage: pnpm --filter @gta/server fund <phone|address> <usd>");
  process.exit(1);
}
if (!config.arc) {
  console.error("Set the Arc settings in apps/server/.env first (ARC_RPC_URL, TREASURY_ADDRESS, OPERATOR_PRIVATE_KEY).");
  process.exit(1);
}

let address = isAddress(who) ? getAddress(who) : undefined;
if (!address) {
  const store = new Store(config.stateFile);
  const digits = who.replace(/\D/g, "");
  const member = store
    .all()
    .flatMap((r) => r.group.members)
    .find((m) => m.wallet && m.id.replace(/\D/g, "").endsWith(digits.slice(-10)));
  if (!member?.wallet) {
    console.error(`No joined member matches ${who}. Pass their Kitty account address instead.`);
    process.exit(1);
  }
  address = getAddress(member.wallet.address);
  console.log(`${member.displayName}: ${address}`);
}

const { publicClient, walletClient } = arcClients(config.arc);
const tx = await sendWelcomeBalance(walletClient, publicClient, address, usdc(usd));
console.log(`sent $${usd} of test money to ${address} (${tx})`);
