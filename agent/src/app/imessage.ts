/**
 * The treasury bot on iMessage. Run: npm start
 *
 * Local mode runs through Messages.app on this Mac, as whatever Apple ID is signed in, and needs
 * Full Disk Access for the terminal. It only acts in chats listed in ALLOWED_SPACE_IDS.
 */
import { Spectrum, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { localIMessage } from "@spectrum-ts/imessage-local";
import { Store } from "../core/store.js";
import { MockTreasury } from "../core/treasury.js";
import { config } from "./config.js";
import { GroupHandler } from "./handler.js";

if (config.imessageMode === "local") {
  // Spectrum calls Photon's cloud at startup whenever these are set, even with only a local provider.
  delete process.env.SPECTRUM_PROJECT_ID;
  delete process.env.SPECTRUM_PROJECT_SECRET;
}

const spaces = new Map<string, Space>();
const store = new Store(config.stateFile, {
  weeklyLimit: config.defaultWeeklyLimit,
  names: config.memberNames,
});
const handler = new GroupHandler(store, new MockTreasury(), {
  async send(spaceId, text) {
    const space = spaces.get(spaceId);
    if (!space) throw new Error(`No open chat ${spaceId}`);
    const sent = await space.send(text);
    return sent?.id;
  },
});

const app = await Spectrum({
  providers: [config.imessageMode === "cloud" ? imessage.config() : localIMessage.config()],
});
console.log(
  `Treasury bot running (${config.imessageMode}), ${config.allowedSpaceIds.size} chat(s) allowlisted.`,
);

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  if (!config.allowedSpaceIds.has(space.id)) continue;

  // Messages from the signed-in Apple ID (including our own replies) can arrive with no sender.
  const sender = message.sender?.id;
  if (!sender) continue;

  spaces.set(space.id, space);
  const content = message.content;
  try {
    switch (content.type) {
      case "text":
        if (content.text.startsWith("🧾 #") || content.text.startsWith("✅ Settled")) break; // our own echo
        await handler.onText(space.id, sender, content.text);
        break;
      case "attachment":
        if (content.mimeType.startsWith("image/")) {
          await handler.onImage(space.id, sender, await content.read());
        }
        break;
      case "reaction":
        console.log(
          `reaction ${JSON.stringify(content.emoji)} from ${sender} on ${content.target.id}`,
        );
        await handler.onReaction(space.id, sender, content.emoji, content.target.id);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(`failed on ${content.type} from ${sender}:`, err);
  }
}
