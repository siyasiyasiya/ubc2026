import { describe, expect, it } from "vitest";
import { addUsdc, formatUsdc, splitEven, usdc } from "./money.js";

describe("usdc / formatUsdc", () => {
  it("constructs from dollars without float dust", () => {
    expect(usdc(12.5)).toBe(12_500_000n);
    expect(usdc(0.1)).toBe(100_000n);
    expect(formatUsdc(usdc(12.5))).toBe("$12.50");
    expect(formatUsdc(usdc(0.05))).toBe("$0.05");
  });

  it("rounds a sub-cent amount to the nearest cent (half up, carrying into dollars)", () => {
    expect(formatUsdc(3_333_334n)).toBe("$3.33"); // $3.333334 → $3.33
    expect(formatUsdc(3_335_000n)).toBe("$3.34"); // $3.335 → $3.34 (half up)
    expect(formatUsdc(99_996_000n)).toBe("$100.00"); // rounds up across the dollar
    expect(formatUsdc(-3_337_000n as ReturnType<typeof usdc>)).toBe("-$3.34");
  });
});

describe("splitEven", () => {
  it("sums exactly back to the total, in whole cents", () => {
    const total = usdc(10); // $10 across 3 → remainder distributed
    const parts = splitEven(total, 3);
    expect(parts.length).toBe(3);
    expect(addUsdc(...parts)).toBe(total);
    // $10 / 3 = $3.33 each with the leftover cent to the first, never a sub-cent amount
    expect(parts[0]).toBe(3_340_000n); // $3.34
    expect(parts[1]).toBe(3_330_000n); // $3.33
    expect(parts[2]).toBe(3_330_000n); // $3.33
  });

  it("throws on zero participants", () => {
    expect(() => splitEven(usdc(5), 0)).toThrow();
  });
});
