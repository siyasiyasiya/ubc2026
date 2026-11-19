/**
 * Attachment diagnostic. Run in a Full-Disk-Access terminal to see what the Photon SDK actually
 * returns for recent messages, so we can tell whether a posted receipt reaches us with its file:
 *
 *   pnpm --filter @gta/server diag
 *
 * Post the receipt in the chat first, then run this within a few minutes.
 */

import { IMessageSDK } from "@photon-ai/imessage-kit";

const MINUTES = Number(process.argv[2] ?? 10);
const since = new Date(Date.now() - MINUTES * 60_000);

const sdk = new IMessageSDK();
try {
  const rows = await sdk.getMessages({ since, excludeReactions: true });
  const withAtt = rows.filter((m) => m.hasAttachments || m.attachments.length > 0);
  console.log(`getMessages since ${since.toLocaleTimeString()}: ${rows.length} rows, ${withAtt.length} with attachments\n`);

  console.log("Last 8 rows overall (newest last):");
  for (const m of rows.slice(-8)) {
    console.log(
      `- ${m.id} chat=…${(m.chatId ?? "null").slice(-8)} isFromMe=${m.isFromMe} kind=${m.chatKind} ` +
        `textLen=${(m.text ?? "").length} hasAtt=${m.hasAttachments} att=${m.attachments.length}`,
    );
  }

  console.log("\nAttachment rows in detail:");
  if (withAtt.length === 0) console.log("  (none — getMessages returned no rows with attachments)");
  for (const m of withAtt) {
    console.log(
      `- ${m.id} chat=…${(m.chatId ?? "null").slice(-8)} isFromMe=${m.isFromMe} kind=${m.chatKind} hasAtt=${m.hasAttachments} att=${m.attachments.length}`,
    );
    for (const a of m.attachments) {
      console.log(`    * ${a.mimeType} ${a.transferStatus} localPath=${a.localPath}`);
    }
  }
} finally {
  await sdk.close();
}
