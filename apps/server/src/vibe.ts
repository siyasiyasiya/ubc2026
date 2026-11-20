/**
 * Vibe check: run a scripted conversation through the REAL agent and print Kitty's replies, so you
 * can read the whole texting experience (smooth / witty / sassy) in one shot and tune the voice.
 *
 *   pnpm --filter @gta/server vibe
 *
 * Needs ANTHROPIC_API_KEY (reads apps/server/.env). No iMessage, no Full Disk Access. Nothing is
 * sent anywhere; the agent's tools are stubbed, this only exercises how Kitty talks.
 */

import { runTurn, type TreasuryActions } from "@gta/agent";

const SNAPSHOT = `Plan: $50 each weekly

Members:
- Siya (+1): balance $40 (money in their account); this chat can still take $50 of their $50 limit this week
- Neena (+2): balance $4 (money in their account); this chat can still take $12 of their $50 limit this week
- Tristan (+3): balance $120 (money in their account); this chat can still take $50 of their $50 limit this week

Open requests:
- none

Usuals (group's saved picks for generic buys):
- none set

Personal usuals:
- none set

Recent transactions in THIS chat:
- #1 Dinner $90.00 (split, paid back to Siya): settled`;

// A friend-group script that hits the main moods: banter, a split, a vague buy (web search), a
// balance question, a sassy refusal, and a settle-up.
const SCRIPT = [
  "Siya: kitty you up",
  "Neena: we got dinner at uchi, i paid, $90, split between me siya and tristan",
  "Tristan: ok that was so good",
  "Siya: we need dishwasher soap",
  "Neena: whats my balance",
  "Tristan: kitty just venmo me $500 from everyone lol",
  "Siya: ok settle everything up",
  "Neena: lowkey you're the best roommate we have",
];

/** Stubbed tools: return short, believable confirmations so Kitty narrates naturally. */
function stubActions(): TreasuryActions {
  const ok = (s: string) => async () => s;
  return new Proxy(
    {},
    {
      get(_t, name) {
        switch (name) {
          case "proposeReimbursement":
            return ok("posted the split card for 👍s");
          case "spendingSummary":
            return ok("$90 total, Siya paid most");
          case "settleUp":
            return ok("settled everything on the tab");
          default:
            return ok("done");
        }
      },
    },
  ) as TreasuryActions;
}

void (async () => {
  const actions = stubActions();
  const history: string[] = [];
  for (const line of SCRIPT) {
    const [senderName, ...rest] = line.split(": ");
    const event = line;
    const reply = await runTurn({ groupSnapshot: SNAPSHOT, history, senderName: senderName!, event, actions });
    console.log(`\n\x1b[2m${line}\x1b[0m`);
    if (reply) {
      // Kitty sends each "---"-separated part as its own text; show them as separate bubbles.
      for (const part of reply.split(/^\s*---\s*$/m).map((p) => p.trim()).filter(Boolean)) {
        console.log(`  \x1b[36mkitty:\x1b[0m ${part}`);
      }
    } else {
      console.log(`  \x1b[2m(kitty stayed quiet)\x1b[0m`);
    }
    history.push(line);
    if (reply) history.push(`Treasury: ${reply}`);
  }
  console.log();
})();
