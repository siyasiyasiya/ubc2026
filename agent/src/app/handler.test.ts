import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { runTurn as RunTurn } from "../agent/brain.js";
import { splitEvenly, usdToUnits } from "../core/money.js";
import { Store } from "../core/store.js";
import { MockTreasury } from "../core/treasury.js";
import type { Proposal } from "../core/types.js";
import { GroupHandler } from "./handler.js";

const NEENA = "+1001";
const SIYA = "+1002";
const TRISTAN = "+1003";
const OUTSIDER = "+1999";

/** Builds a handler whose "agent" proposes a $90 dinner paid by Neena, split three ways. */
function setup(weeklyLimitUsd = 200) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "treasury-")), "state.json");
  const store = new Store(file, {
    weeklyLimit: usdToUnits(weeklyLimitUsd),
    names: { [NEENA]: "Neena", [SIYA]: "Siya", [TRISTAN]: "Tristan", [OUTSIDER]: "Mallory" },
  });
  const sent: { id: string; text: string }[] = [];
  const fakeTurn: typeof RunTurn = async (s, { group, sender }) => {
    const total = usdToUnits(90);
    const proposal: Proposal = {
      number: s.nextProposalNumber(group),
      kind: "reimburse",
      title: "Dinner",
      total,
      payer: NEENA,
      shares: splitEvenly(total, [NEENA, SIYA, TRISTAN]),
      approvals: [],
      status: "pending",
      createdBy: sender,
      createdAt: new Date().toISOString(),
    };
    group.proposals.push(proposal);
    return { reply: "Splitting dinner three ways.", newProposals: [proposal] };
  };
  const handler = new GroupHandler(
    store,
    new MockTreasury(),
    {
      async send(_space, text) {
        const id = `msg-${sent.length + 1}`;
        sent.push({ id, text });
        return id;
      },
    },
    {
      runTurn: fakeTurn,
      readReceipt: async () => null,
    },
  );
  return { store, handler, sent, group: () => store.group("g") };
}

async function proposeDinner(ctx: ReturnType<typeof setup>) {
  for (const who of [NEENA, SIYA, TRISTAN, OUTSIDER]) ctx.store.ensureMember(ctx.group(), who);
  await ctx.handler.onText("g", NEENA, "split dinner with siya and tristan");
  const proposal = ctx.group().proposals[0]!;
  assert.ok(proposal.cardMessageId, "approval card was posted and its id recorded");
  return proposal;
}

test("posts an approval card and settles once both participants 👍 it", async () => {
  const ctx = setup();
  const proposal = await proposeDinner(ctx);
  assert.match(ctx.sent[1]!.text, /#1 Dinner: \$90\.00/);

  await ctx.handler.onReaction("g", SIYA, "👍", proposal.cardMessageId!);
  assert.equal(proposal.status, "pending", "one approval isn't enough");

  await ctx.handler.onReaction("g", TRISTAN, "👍", `p:0/${proposal.cardMessageId}`);
  assert.equal(proposal.status, "settled");
  assert.match(ctx.sent.at(-1)!.text, /Settled #1/);
  assert.equal(proposal.settlement?.transfers.length, 2);
});

test("👍 from someone outside the split, or a different emoji, doesn't count", async () => {
  const ctx = setup();
  const proposal = await proposeDinner(ctx);
  await ctx.handler.onReaction("g", OUTSIDER, "👍", proposal.cardMessageId!);
  await ctx.handler.onReaction("g", SIYA, "😂", proposal.cardMessageId!);
  await ctx.handler.onReaction("g", NEENA, "👍", proposal.cardMessageId!); // payer
  assert.deepEqual(proposal.approvals, []);
  assert.equal(proposal.status, "pending");
});

test("a bare 👍 text reply approves the sender's open proposal", async () => {
  const ctx = setup();
  const proposal = await proposeDinner(ctx);
  await ctx.handler.onText("g", SIYA, "👍");
  await ctx.handler.onText("g", TRISTAN, "👍");
  assert.equal(proposal.status, "settled");
});

test("a share over someone's weekly limit is refused and nothing is charged", async () => {
  const ctx = setup(20); // $20/week, but each share is $30
  const proposal = await proposeDinner(ctx);
  await ctx.handler.onReaction("g", SIYA, "👍", proposal.cardMessageId!);
  await ctx.handler.onReaction("g", TRISTAN, "👍", proposal.cardMessageId!);
  assert.equal(proposal.status, "rejected");
  assert.match(ctx.sent.at(-1)!.text, /Couldn't settle #1.*Nothing was charged/s);
  assert.deepEqual(ctx.group().spending, {});
});
