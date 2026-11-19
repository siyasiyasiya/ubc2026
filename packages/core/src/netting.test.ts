import { describe, expect, it } from "vitest";
import { netTransfers } from "./netting.js";
import { usdc } from "./money.js";

const sum = (ts: { amount: bigint }[]) => ts.reduce((a, t) => a + t.amount, 0n);

describe("netTransfers", () => {
  it("collapses a chain: A owes B, B owes C → A owes C", () => {
    const out = netTransfers([
      { from: "A", to: "B", amount: usdc(10) },
      { from: "B", to: "C", amount: usdc(10) },
    ]);
    expect(out).toEqual([{ from: "A", to: "C", amount: usdc(10) }]);
  });

  it("cancels a mutual debt to nothing", () => {
    const out = netTransfers([
      { from: "A", to: "B", amount: usdc(10) },
      { from: "B", to: "A", amount: usdc(10) },
    ]);
    expect(out).toEqual([]);
  });

  it("leaves an already-minimal set alone (one payer to two)", () => {
    const out = netTransfers([
      { from: "A", to: "B", amount: usdc(10) },
      { from: "A", to: "C", amount: usdc(5) },
    ]);
    // A owes $15 total, split between B ($10) and C ($5): still 2 transfers.
    expect(out).toHaveLength(2);
    expect(sum(out)).toBe(usdc(15));
    expect(out.find((t) => t.to === "B")?.amount).toBe(usdc(10));
    expect(out.find((t) => t.to === "C")?.amount).toBe(usdc(5));
  });

  it("reduces a tangle to fewer transfers and conserves money", () => {
    // Everyone owes everyone a bit; nets down.
    const out = netTransfers([
      { from: "siya", to: "neena", amount: usdc(10) },
      { from: "neena", to: "tristan", amount: usdc(10) },
      { from: "tristan", to: "siya", amount: usdc(4) },
    ]);
    // Net: siya -6, neena 0, tristan +6 → one transfer siya→tristan $6.
    expect(out).toEqual([{ from: "siya", to: "tristan", amount: usdc(6) }]);
  });

  it("is deterministic and reconciles totals for independent debts", () => {
    const debts = [
      { from: "joey", to: "siya", amount: usdc(10) },
      { from: "mallory", to: "neena", amount: usdc(6) },
    ];
    const a = netTransfers(debts);
    const b = netTransfers(debts);
    expect(a).toEqual(b); // deterministic
    expect(sum(a)).toBe(usdc(16));
  });
});
