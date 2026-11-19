/**
 * Crossmint setup and a real test order from the terminal, without the iMessage bot.
 *
 *   pnpm --filter @gta/server crossmint card            print the save-card link (valid 1 hour)
 *   pnpm --filter @gta/server crossmint buy "<what or URL>"   build the cart, show the total,
 *                                                       and charge the card only after you type "yes"
 *
 * Needs CROSSMINT_API_KEY, CROSSMINT_CLIENT_API_KEY, CROSSMINT_USER_ID, CROSSMINT_JWT_PRIVATE_KEY,
 * and for `buy` CROSSMINT_PAYMENT_METHOD_ID (see apps/server/.env.example).
 */

import { createInterface } from "node:readline/promises";
import { formatUsdc } from "@gta/core";
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
  const request = rest.join(" ");
  const store = createCrossmintPurchaseAdapterFromEnv();
  console.log(`Shopping for "${request}" (this takes a minute or two)…`);
  const cart = await store.buildCart({
    requestText: request,
    checkout: { kind: "store_account", memberId: "cli", store: store.store },
  });
  console.log(`\n${cart.store}: ${formatUsdc(cart.total)}`);
  for (const li of cart.lineItems) console.log(`  ${li.quantity} × ${li.name}  ${formatUsdc(li.unitPrice)}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nCharge the card ${formatUsdc(cart.total)} and place this order? Type "yes": `);
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("Not ordered. Nothing was charged.");
    process.exit(0);
  }
  const receipt = await store.placeOrder({ cart });
  console.log(`\nOrdered ✅ ${receipt.merchant}, ${formatUsdc(receipt.total)}`);
} else {
  console.error('usage: pnpm --filter @gta/server crossmint card | buy "<what or URL>"');
  process.exit(1);
}
