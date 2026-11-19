import { describe, expect, it } from "vitest";
import { byItemSplit } from "./split.js";
import { usdc } from "./money.js";
import type { ReceiptLineItem } from "./types.js";

const items: ReceiptLineItem[] = [
  { name: "pasta", amount: usdc(20) }, // 0
  { name: "roll", amount: usdc(15) }, //  1
  { name: "sake", amount: usdc(30) }, //  2
  { name: "tea", amount: usdc(5) }, //    3
];

describe("byItemSplit", () => {
  it("charges each person for the items they claimed", () => {
    const split = byItemSplit({
      lineItems: items,
      claims: { siya: [0, 2], neena: [1, 3] }, // siya: pasta+sake=50, neena: roll+tea=20
      payeeMemberId: "neena",
    });
    expect(split.shares).toEqual({ siya: usdc(50), neena: usdc(20) });
    expect(split.total).toBe(usdc(70));
    expect(split.method).toEqual({ kind: "by_item" });
  });

  it("divides a shared item among its claimers", () => {
    const split = byItemSplit({
      lineItems: [{ name: "pizza", amount: usdc(30) }],
      claims: { a: [0], b: [0], c: [0] }, // split the $30 pizza 3 ways
      payeeMemberId: "a",
    });
    expect(split.shares).toEqual({ a: usdc(10), b: usdc(10), c: usdc(10) });
    expect(split.total).toBe(usdc(30));
  });

  it("adds tax and tip proportional to each person's items, summing exactly", () => {
    // siya items $50, neena items $20 (total $70); tax+tip $14 → split 10 / 4 by proportion (5:2).
    const split = byItemSplit({
      lineItems: items,
      claims: { siya: [0, 2], neena: [1, 3] },
      tax: usdc(7),
      tip: usdc(7),
      payeeMemberId: "neena",
    });
    expect(split.shares).toEqual({ siya: usdc(60), neena: usdc(24) });
    const sum = Object.values(split.shares).reduce((a, b) => a + b, 0n);
    expect(sum).toBe(split.total); // shares always reconcile to the total
    expect(split.total).toBe(usdc(84));
  });

  it("reconciles odd cents to the total with no money lost", () => {
    const split = byItemSplit({
      lineItems: [{ name: "a", amount: usdc(10) }, { name: "b", amount: usdc(5) }],
      claims: { x: [0], y: [1] },
      tip: usdc(1), // $1 over $15 of items → 0.67 / 0.33, must still sum to $16
      payeeMemberId: "x",
    });
    const sum = Object.values(split.shares).reduce((a, b) => a + b, 0n);
    expect(sum).toBe(split.total);
    expect(split.total).toBe(usdc(16));
  });

  it("throws when nobody claimed anything", () => {
    expect(() => byItemSplit({ lineItems: items, claims: {}, payeeMemberId: "a" })).toThrow(/no claims/);
  });
});
