/**
 * Photon spike: proves the iMessage pieces the treasury agent depends on.
 *
 * Checks, in a real chat:
 *  1. receive text in a DM and in a group chat, and reply into the same chat
 *  2. receive a photo (receipt) and read its bytes
 *  3. receive a tapback (👍) and see which message it targets
 *  4. receive a voice memo (for the ElevenLabs speech-to-text path)
 *
 * Modes (IMESSAGE_MODE in agent/.env):
 *  - "local" (default): runs on this Mac through Messages.app, as whatever Apple ID is signed in.
 *    Needs Full Disk Access for the terminal. No Photon account needed.
 *  - "cloud": Photon Stable cloud line. Needs SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET.
 *
 * Safety: in local mode the bot can read every chat on the signed-in account, so it only REPLIES in
 * chats listed in ALLOWED_SPACE_IDS (comma-separated). Every other message is logged with its space
 * id and ignored, so you can copy the test group's id into the allowlist.
 *
 * Run: npm run spike
 */
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { localIMessage } from "@spectrum-ts/imessage-local";

const mode = process.env.IMESSAGE_MODE ?? "local";
const BOT_PREFIXES = ["🤖", "🧾", "👀", "🎙️"];
const allowed = new Set(
  (process.env.ALLOWED_SPACE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (mode !== "cloud") {
  // Spectrum calls Photon's cloud at startup whenever these are set, even with only a local provider.
  delete process.env.SPECTRUM_PROJECT_ID;
  delete process.env.SPECTRUM_PROJECT_SECRET;
}

const provider = mode === "cloud" ? imessage.config() : localIMessage.config();
const app = await Spectrum({ providers: [provider] });
console.log(`Photon spike running (${mode}). Allowlisted chats: ${allowed.size || "none yet"}`);

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;

  const content = message.content;
  // In local mode, messages from the signed-in account (including the bot's own replies) can arrive
  // as "inbound" with an empty sender id. Skip them so the bot never answers itself in a loop.
  const fromSelf = !message.sender?.id;
  const isBotEcho = content.type === "text" && BOT_PREFIXES.some((p) => content.text.startsWith(p));
  if (fromSelf || isBotEcho) {
    console.log(`[${space.id}] skipped own message (${content.type})`);
    continue;
  }
  console.log(`[${space.id}] ${content.type} from`, message.sender, "msg", message.id);

  if (mode === "local" && !allowed.has(space.id)) {
    // Never log other chats' text. A "#treasury" message marks the chat to allowlist.
    if (content.type === "text" && content.text.toLowerCase().includes("#treasury")) {
      console.log(`  CLAIM: add ${space.id} to ALLOWED_SPACE_IDS`);
    } else {
      console.log("  not allowlisted, ignoring");
    }
    continue;
  }

  try {
    switch (content.type) {
      case "text":
        await space.send(`🤖 treasury bot got: "${content.text}"`);
        break;

      case "attachment": {
        const bytes = await content.read();
        console.log(`  attachment ${content.name} ${content.mimeType} ${bytes.length} bytes`);
        await space.send(`🧾 got your ${content.mimeType} (${Math.round(bytes.length / 1024)} KB)`);
        break;
      }

      case "reaction":
        console.log(`  reaction ${JSON.stringify(content.emoji)} on ${content.target.id}`);
        await space.send(`👀 saw ${content.emoji} on message ${content.target.id}`);
        break;

      case "voice": {
        const audio = await content.read();
        console.log(`  voice memo ${content.mimeType} ${audio.length} bytes`);
        await space.send(`🎙️ got a voice memo (${content.duration ?? "?"}s)`);
        break;
      }

      default:
        console.log("  unhandled content", content.type);
    }
  } catch (err) {
    console.error("  handler failed:", err);
  }
}
