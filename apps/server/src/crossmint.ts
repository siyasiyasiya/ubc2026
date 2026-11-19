/**
 * Crossmint setup and a real test order from the terminal, without the iMessage bot.
 *
 *   pnpm --filter @gta/server crossmint card            print the save-card link (valid 1 hour)
 *   pnpm --filter @gta/server crossmint buy "<what or URL>"   build the cart, show the total,
 *                                                       and charge the card only after you type "yes"
 *   ... crossmint buy --max 3 "<what or URL>"           no prompt: charge only if the real total
 *                                                       (tax and shipping included) is at most $3
 *
 * Needs CROSSMINT_API_KEY, CROSSMINT_CLIENT_API_KEY, CROSSMINT_USER_ID, CROSSMINT_JWT_PRIVATE_KEY,
 * and for `buy` CROSSMINT_PAYMENT_METHOD_ID (see apps/server/.env.example).
 */

import { createInterface } from "node:readline/promises";
import { formatUsdc, usdc } from "@gta/core";
import { createCrossmintPurchaseAdapterFromEnv, crossmintJwtSignerFromEnv } from "@gta/purchase";

const [command, ...rest] = process.argv.slice(2);
const onboardUrl = (process.env.ONBOARD_URL ?? "https://kittyagent.vercel.app").replace(/\/$/, "");

function need(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Set ${key} in apps/server/.env first (see .env.example).`);
    process.exit(1);
  }
  return v;
}

if (command === "card") {
  const clientKey = need("CROSSMINT_CLIENT_API_KEY");
  const jwt = crossmintJwtSignerFromEnv().tokenFor(need("CROSSMINT_USER_ID"));
  // In the hash, so neither the key nor the token reaches Vercel's logs.
  const hash = new URLSearchParams({ k: clientKey, t: jwt }).toString();
  console.log(`Open on your phone or laptop (valid 1 hour):\n\n${onboardUrl}/card.html#${hash}\n`);
  console.log("Then put the id it shows in apps/server/.env as CROSSMINT_PAYMENT_METHOD_ID.");
} else if (command === "buy" && rest.length > 0) {
  const maxAt = rest.indexOf("--max");
  const maxUsd = maxAt >= 0 ? Number(rest.splice(maxAt, 2)[1]) : undefined;
  if (maxUsd !== undefined && !(Number.isFinite(maxUsd) && maxUsd > 0)) {
    console.error("--max needs a dollar amount, e.g. --max 3");
    process.exit(1);
  }
  const max = maxUsd !== undefined ? usdc(maxUsd) : undefined;
  const request = rest.join(" ");
  // The cap is also Crossmint's budget, so its browser won't go past it either.
  const store = createCrossmintPurchaseAdapterFromEnv(process.env, max !== undefined ? { maxCost: max } : {});
  console.log(`Shopping for "${request}" (this takes a minute or two)…`);
  const cart = await store.buildCart({
    requestText: request,
    checkout: { kind: "store_account", memberId: "cli", store: store.store },
  });
  console.log(`\n${cart.store}: ${formatUsdc(cart.total)}`);
  for (const li of cart.lineItems) console.log(`  ${li.quantity} × ${li.name}  ${formatUsdc(li.unitPrice)}`);

  let ok: boolean;
  if (max !== undefined) {
    ok = cart.total <= max;
    console.log(ok ? `\nUnder the ${formatUsdc(max)} cap, ordering.` : `\nOver the ${formatUsdc(max)} cap.`);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nCharge the card ${formatUsdc(cart.total)} and place this order? Type "yes": `);
    rl.close();
    ok = answer.trim().toLowerCase() === "yes";
  }
  if (!ok) {
    console.log("Not ordered. Nothing was charged.");
    process.exit(0);
  }
  const receipt = await store.placeOrder({ cart });
  console.log(`\nOrdered ✅ ${receipt.merchant}, ${formatUsdc(receipt.total)}`);
} else {
  console.error('usage: pnpm --filter @gta/server crossmint card | buy [--max <usd>] "<what or URL>"');
  process.exit(1);
}
