import { describe, expect, it } from "vitest";
import { addUsdc, formatUsdc, splitEven, usdc } from "./money.js";

describe("usdc / formatUsdc", () => {
  it("constructs from dollars without float dust", () => {
    expect(usdc(12.5)).toBe(12_500_000n);
    expect(usdc(0.1)).toBe(100_000n);
    expect(formatUsdc(usdc(12.5))).toBe("$12.50");
    expect(formatUsdc(usdc(0.05))).toBe("$0.05");
  });
});

describe("splitEven", () => {
  it("sums exactly back to the total", () => {
    const total = usdc(10); // $10 across 3 → remainder distributed
    const parts = splitEven(total, 3);
    expect(parts.length).toBe(3);
    expect(addUsdc(...parts)).toBe(total);
    // $10 / 3 = 3.333333 each, remainder of 1 micro handed to the first
    expect(parts[0]).toBe(3_333_334n);
    expect(parts[1]).toBe(3_333_333n);
    expect(parts[2]).toBe(3_333_333n);
  });

  it("throws on zero participants", () => {
    expect(() => splitEven(usdc(5), 0)).toThrow();
  });
});
