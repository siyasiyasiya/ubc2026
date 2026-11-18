/**
 * Read-only check of how iMessage reactions reach the bot. Prints every reaction row and what
 * PhotonChatPort turns it into. Never prints message text and never sends anything.
 *
 * Run from Terminal.app (it needs Full Disk Access):
 *   pnpm --filter @gta/imessage exec tsx scripts/watch-reactions.ts
 *
 * Optional: WATCH_CHAT_ID=<chat id> to only show one chat.
 */

import { IMessageSDK, type Message } from "@photon-ai/imessage-kit";
import { chatDbSenderResolver, mapReactionRow } from "../src/index.js";

const only = process.env.WATCH_CHAT_ID;
const sdk = new IMessageSDK();
const resolveSender = chatDbSenderResolver();

function show(label: string, m: Message): void {
  if (only && m.chatId !== only) return;
  if (!m.reaction) {
    // Ids only, so we can see which message a later reaction targets.
    console.log(`${label} message id=${m.id} chat=${m.chatId}`);
    return;
  }
  const r = m.reaction;
  console.log(
    `${label} REACTION chat=${m.chatId} from=${m.participant ?? "me"} kind=${r.kind} emoji=${JSON.stringify(r.emoji)} ` +
      `target=${r.targetMessageId} removed=${r.isRemoved}`,
  );
  console.log(`  -> app sees: ${JSON.stringify(mapReactionRow(m, resolveSender))}`);
}

await sdk.startWatching({
  onIncomingMessage: (m) => show("in ", m),
  onFromMeMessage: (m) => show("me ", m),
  onError: (e) => console.error("watcher error:", e.message),
});
console.log(`Watching reactions${only ? ` in ${only}` : " in all chats"}. Ctrl+C to stop.`);
