/**
 * Terminal simulator: the real agent, runtime, and wallet, with a fake chat. No iMessage needed.
 *
 *   pnpm --filter @gta/server sim
 *
 *   neena: dinner at uchi friday?        a member says something
 *   /photo neena ./receipt.jpg           a member posts a photo
 *   /like siya 1                         a member 👍s the card for request #1
 *   /state                               print the group's state
 */

import path from "node:path";
import readline from "node:readline/promises";
import { ClaudeReceiptReader, runTurn } from "@gta/agent";
import type { ChatPort, IncomingMessage, IncomingReaction } from "@gta/core";
import { InMemoryWalletAdapter } from "@gta/wallet";
import { config, warnIfNoClaudeAuth } from "./config.js";
import { GroupRuntime } from "./runtime.js";
import { Store } from "./store.js";

warnIfNoClaudeAuth();

const CHAT = "sim-group";
const handles: Record<string, string> = { neena: "+15550000001", siya: "+15550000002", tristan: "+15550000003" };

let nextId = 1;
const messageHandlers: ((m: IncomingMessage) => void)[] = [];
const reactionHandlers: ((r: IncomingReaction) => void)[] = [];
const chat: ChatPort = {
  async postMessage(chatId, text) {
    const id = `sim-${nextId++}`;
    console.log(`\n🤖 Treasury [${id}]:\n${text}\n`);
    return { id, chatId };
  },
  async postImage(chatId, image, caption) {
    return this.postMessage(chatId, `[image ${image.uri}] ${caption ?? ""}`);
  },
  async sendDirectMessage(handle, text) {
    return this.postMessage(`dm:${handle}`, text);
  },
  onMessage: (h) => (messageHandlers.push(h), () => undefined),
  onReaction: (h) => (reactionHandlers.push(h), () => undefined),
  async getParticipants() {
    return Object.values(handles);
  },
};

const store = new Store(process.env.SIM_STATE_FILE);
const runtime = new GroupRuntime({
  chat,
  wallet: new InMemoryWalletAdapter(),
  receipts: new ClaudeReceiptReader(),
  runTurn,
  store,
  defaultLimit: config.defaultLimit,
  names: { "+15550000001": "Neena", "+15550000002": "Siya", "+15550000003": "Tristan" },
  log: (line) => console.log(`  (${line})`),
});
runtime.attach();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Simulator ready. Members: neena, siya, tristan. Try: neena: dinner at uchi friday?");

for await (const raw of rl) {
  const line = raw.trim();
  if (!line) continue;
  const at = Date.now();
  if (line === "/state") {
    console.dir(store.get(CHAT), { depth: 6 });
  } else if (line.startsWith("/photo ")) {
    const [, who = "", file = ""] = line.split(/\s+/);
    const handle = handles[who];
    if (!handle) console.error(`Unknown member ${who}`);
    else messageHandlers.forEach((h) => h({ chatId: CHAT, senderHandle: handle, text: "", attachments: [{ uri: path.resolve(file) }], at }));
  } else if (line.startsWith("/like ")) {
    const [, who = "", num = ""] = line.split(/\s+/);
    const handle = handles[who];
    const target = store.get(CHAT)?.requests.find((r) => r.number === Number(num))?.previewMessageId;
    if (!handle || !target) console.error("Usage: /like <member> <request number>");
    else reactionHandlers.forEach((h) => h({ chatId: CHAT, senderHandle: handle, targetMessageId: target, emoji: "👍", added: true, at }));
  } else {
    const match = /^(\w+):\s*(.+)$/.exec(line);
    const handle = match ? handles[match[1]!.toLowerCase()] : undefined;
    if (!match || !handle) console.error("Write it as  name: message");
    else messageHandlers.forEach((h) => h({ chatId: CHAT, senderHandle: handle, text: match[2]!, attachments: [], at }));
  }
  await runtime.serial(async () => undefined); // wait for the event to finish before the next prompt
}
