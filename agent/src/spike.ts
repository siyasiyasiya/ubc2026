/**
 * Photon spike: proves the iMessage pieces the treasury agent depends on.
 *
 * Checks, in a real chat:
 *  1. receive text in a DM and in a group chat, and reply into the same chat
 *  2. receive a photo (receipt) and read its bytes
 *  3. receive a tapback (👍) and see which message it targets
 *  4. receive a voice memo (for the ElevenLabs speech-to-text path)
 *
 * Run: npm run spike  (needs SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET in agent/.env)
 */
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({ providers: [imessage.config()] });
console.log("Photon spike running. Text the line, post a photo, or 👍 a message.");

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;

  const chatType = imessage(space).type; // "dm" | "group"
  const content = message.content;
  console.log(`[${chatType}] ${content.type} from`, message.sender, "msg", message.id);

  try {
    switch (content.type) {
      case "text":
        await space.send(`🤖 got it (${chatType}): "${content.text}"`);
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
