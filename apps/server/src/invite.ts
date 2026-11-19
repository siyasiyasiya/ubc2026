/**
 * Prints a Face ID invite link, for use until the iMessage adapter can send DMs.
 *
 *   pnpm --filter @gta/server invite <chatId> <handle> [name] [chat name]
 *
 * Tickets are derived from INVITE_SECRET, so this works while the bot is running and the bot's
 * join watcher will recognise the join. The member must have talked in the chat (or be in
 * MEMBER_NAMES) for the bot to know them when the join arrives.
 */

import { inviteLink } from "@gta/wallet";
import { config } from "./config.js";

const [chatId, handle, name, chatName] = process.argv.slice(2);
if (!chatId || !handle) {
  console.error("usage: pnpm --filter @gta/server invite <chatId> <handle> [name] [chat name]");
  process.exit(1);
}
if (!config.invites) {
  console.error("Set INVITE_SECRET in apps/server/.env first (any long random string, kept stable).");
  process.exit(1);
}
console.log(
  inviteLink({
    ...config.invites,
    chatId,
    chatName: chatName ?? "your group",
    handle,
    displayName: name ?? config.names[handle] ?? "",
    limit: config.defaultLimit,
  }),
);
