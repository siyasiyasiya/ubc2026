import { describe, expect, it } from "vitest";
import { moneyToUsdc, parseDecimalToUsdc, usdcToDecimalString } from "./money-codec.js";

describe("parseDecimalToUsdc", () => {
  it("parses decimal strings to micro-USDC without float dust", () => {
    expect(parseDecimalToUsdc("12.49")).toBe(12_490_000n);
    expect(parseDecimalToUsdc("0.10")).toBe(100_000n);
    expect(parseDecimalToUsdc("7")).toBe(7_000_000n);
    expect(parseDecimalToUsdc("100.00")).toBe(100_000_000n);
    // 6-decimal (sub-cent) precision is preserved, not rounded to cents.
    expect(parseDecimalToUsdc("0.000001")).toBe(1n);
    expect(parseDecimalToUsdc("1.234567")).toBe(1_234_567n);
  });

  it("tolerates whitespace, commas and currency symbols", () => {
    expect(parseDecimalToUsdc(" $1,234.56 ")).toBe(1_234_560_000n);
  });

  it("rejects garbage", () => {
    expect(() => parseDecimalToUsdc("not-money")).toThrow();
    expect(() => parseDecimalToUsdc("")).toThrow();
  });
});

describe("moneyToUsdc", () => {
  it("reads either the `value` or `amount` field", () => {
    expect(moneyToUsdc({ value: "42.50", currency: "USD" })).toBe(42_500_000n);
    expect(moneyToUsdc({ amount: "16.00", currency: "USD" })).toBe(16_000_000n);
  });

  it("accepts USD (and missing currency) but rejects other currencies", () => {
    expect(moneyToUsdc({ value: "1.00" })).toBe(1_000_000n);
    expect(() => moneyToUsdc({ value: "1.00", currency: "EUR" })).toThrow(/USD/);
  });
});

describe("usdcToDecimalString", () => {
  it("renders micros back to a decimal string for Crossmint", () => {
    expect(usdcToDecimalString(100_000_000n as never)).toBe("100.00");
    expect(usdcToDecimalString(12_490_000n as never)).toBe("12.49");
    expect(usdcToDecimalString(7_000_000n as never)).toBe("7.00");
    // keeps sub-cent precision when present
    expect(usdcToDecimalString(1_234_567n as never)).toBe("1.234567");
  });

  it("round-trips through parseDecimalToUsdc", () => {
    for (const s of ["0.01", "9.99", "250.00"]) {
      expect(usdcToDecimalString(parseDecimalToUsdc(s))).toBe(s);
    }
  });
});
