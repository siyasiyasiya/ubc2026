/**
 * One-off diagnostic: send a single iMessage via the SAME path the bot uses (imessage-kit ->
 * Messages.app). If this fails or nothing arrives, the bot's sends will fail the same way.
 *
 *   pnpm --filter @gta/imessage exec tsx scripts/send-test.ts <handle> [message...]
 */
import { IMessageSDK } from "@photon-ai/imessage-kit";

const to = process.argv[2];
const text = process.argv.slice(3).join(" ") || "test from Kitty 🐱 (please ignore)";
if (!to) {
  console.error("usage: tsx scripts/send-test.ts <handle> [message...]");
  process.exit(1);
}

const sdk = new IMessageSDK();
try {
  console.log(`sending to ${to}: ${JSON.stringify(text)} ...`);
  await sdk.send({ to, text });
  console.log("✅ send() resolved (Messages.app accepted the dispatch).");
  console.log("   NOTE: this only means it was handed to Messages, not that it delivered.");
  console.log("   Check the recipient's phone to confirm it actually arrived.");
} catch (err) {
  console.error("❌ send() threw:", err);
} finally {
  await sdk.close();
}
