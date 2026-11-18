import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsd, splitByAmounts, splitEvenly, sumShares, usdToUnits } from "./money.js";
import { MockTreasury, settlementProblems, weekStart } from "./treasury.js";
import type { GroupState, Proposal } from "./types.js";

test("usdToUnits rounds to the cent", () => {
  assert.equal(usdToUnits(12.345), 12_350_000);
  assert.equal(formatUsd(usdToUnits(186.4)), "$186.40");
  assert.throws(() => usdToUnits(-1));
});

test("splitEvenly gives leftover cents to the first people and sums exactly", () => {
  const shares = splitEvenly(usdToUnits(100), ["a", "b", "c"]);
  assert.deepEqual(shares, { a: 33_340_000, b: 33_330_000, c: 33_330_000 });
  assert.equal(sumShares(shares), usdToUnits(100));
});

test("splitByAmounts absorbs a cent of rounding but rejects bigger mismatches", () => {
  const shares = splitByAmounts(usdToUnits(30), { a: usdToUnits(20), b: usdToUnits(9.99) });
  assert.equal(sumShares(shares), usdToUnits(30));
  assert.equal(shares.a, usdToUnits(20.01));
  assert.throws(() => splitByAmounts(usdToUnits(30), { a: usdToUnits(20), b: usdToUnits(5) }));
});

test("weekStart returns the Monday of the week", () => {
  assert.equal(weekStart(new Date("2026-11-18T12:00:00Z")), "2026-11-16"); // Wednesday
  assert.equal(weekStart(new Date("2026-11-16T00:00:00Z")), "2026-11-16"); // Monday
  assert.equal(weekStart(new Date("2026-11-22T23:00:00Z")), "2026-11-16"); // Sunday
});

function fixture(): { group: GroupState; proposal: Proposal } {
  const group: GroupState = {
    spaceId: "g",
    members: [
      { handle: "neena", name: "Neena", weeklyLimit: usdToUnits(200) },
      { handle: "siya", name: "Siya", weeklyLimit: usdToUnits(200) },
      { handle: "tristan", name: "Tristan", weeklyLimit: usdToUnits(50) },
    ],
    proposals: [],
    spending: {},
  };
  const total = usdToUnits(120);
  const proposal: Proposal = {
    number: 1,
    kind: "reimburse",
    title: "Dinner",
    total,
    payer: "neena",
    shares: splitEvenly(total, ["neena", "siya", "tristan"]),
    approvals: [],
    status: "pending",
    createdBy: "neena",
    createdAt: new Date().toISOString(),
  };
  group.proposals.push(proposal);
  return { group, proposal };
}

test("settlement needs every non-payer participant to approve", async () => {
  const { group, proposal } = fixture();
  proposal.approvals = ["siya"];
  assert.match(settlementProblems(group, proposal).join(), /not everyone/);

  proposal.approvals = ["siya", "tristan"];
  assert.deepEqual(settlementProblems(group, proposal), []);
  const result = await new MockTreasury().settle(group, proposal);
  assert.equal(result.ok, true);
  assert.equal(result.transfers.length, 2);
  assert.ok(result.transfers.every((t) => t.to === "neena" && t.amount === usdToUnits(40)));
});

test("a share over someone's remaining weekly limit is refused", async () => {
  const { group, proposal } = fixture();
  proposal.approvals = ["siya", "tristan"];
  group.spending.tristan = { weekStart: weekStart(), amount: usdToUnits(20) }; // $30 left, share is $40
  const result = await new MockTreasury().settle(group, proposal);
  assert.equal(result.ok, false);
  assert.match(
    result.error ?? "",
    /Tristan's share \$40\.00 is over their remaining weekly limit \(\$30\.00\)/,
  );
});

test("a settled proposal can't be settled twice", async () => {
  const { group, proposal } = fixture();
  proposal.status = "settled";
  proposal.approvals = ["siya", "tristan"];
  assert.match(settlementProblems(group, proposal).join(), /already settled/);
});
