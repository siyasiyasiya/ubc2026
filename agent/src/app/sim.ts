/**
 * Terminal simulator: test the agent without iMessage. Run: npm run sim
 *
 *   neena: dinner at uchi friday?        a member says something
 *   /photo neena ./receipt.jpg           a member posts a photo
 *   /like siya 1                         a member 👍s the card for proposal #1
 *   /state                               print the group's state
 */
import fs from "node:fs";
import readline from "node:readline/promises";
import { Store } from "../core/store.js";
import { MockTreasury } from "../core/treasury.js";
import { GroupHandler } from "./handler.js";

const SPACE = "sim-group";
const members: Record<string, string> = {
  neena: "+15550000001",
  siya: "+15550000002",
  tristan: "+15550000003",
};

const store = new Store(process.env.SIM_STATE_FILE ?? "data/sim-state.json", {
  weeklyLimit: 200_000_000,
  names: { "+15550000001": "Neena", "+15550000002": "Siya", "+15550000003": "Tristan" },
});
let nextId = 1;
const handler = new GroupHandler(store, new MockTreasury(), {
  async send(_spaceId, text) {
    const id = `sim-${nextId++}`;
    console.log(`\n🤖 Treasury [${id}]:\n${text}\n`);
    return id;
  },
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Simulator ready. Members: neena, siya, tristan. Try: neena: dinner at uchi friday?");

for await (const raw of rl) {
  const line = raw.trim();
  if (!line) continue;
  try {
    if (line === "/state") {
      console.log(JSON.stringify(store.group(SPACE), null, 2));
    } else if (line.startsWith("/photo ")) {
      const [, who = "", file = ""] = line.split(/\s+/);
      const handle = members[who];
      if (!handle) throw new Error(`Unknown member ${who}`);
      await handler.onImage(SPACE, handle, fs.readFileSync(file));
    } else if (line.startsWith("/like ")) {
      const [, who = "", num = ""] = line.split(/\s+/);
      const handle = members[who];
      const proposal = store.findProposal(store.group(SPACE), Number(num));
      if (!handle || !proposal?.cardMessageId)
        throw new Error("Usage: /like <member> <proposal number>");
      await handler.onReaction(SPACE, handle, "👍", proposal.cardMessageId);
    } else {
      const match = /^(\w+):\s*(.+)$/.exec(line);
      const handle = match ? members[match[1]!.toLowerCase()] : undefined;
      if (!match || !handle) throw new Error("Write it as  name: message");
      await handler.onText(SPACE, handle, match[2]!);
    }
  } catch (err) {
    console.error((err as Error).message);
  }
}
