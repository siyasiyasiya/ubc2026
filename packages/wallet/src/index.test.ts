import { usdc, type Member } from "@gta/core";
import { describe, expect, it } from "vitest";
import { InMemoryWalletAdapter, periodStart } from "./index.js";

const tristan: Member = {
  id: "tristan",
  displayName: "Tristan",
  handle: { kind: "phone", value: "+15550000003" },
  limit: { amount: usdc(50), period: "weekly" },
};
const to = { kind: "wallet" as const, address: "0xneena" };

describe("InMemoryWalletAdapter", () => {
  it("pulls within the limit and tracks what's left", async () => {
    const wallet = new InMemoryWalletAdapter(() => new Date("2026-11-18T12:00:00Z"));
    const result = await wallet.pull({ from: tristan, to, amount: usdc(30), idempotencyKey: "a" });
    expect(result.status).toBe("pulled");
    expect((await wallet.getLimitStatus(tristan)).remaining).toBe(usdc(20));
  });

  it("refuses a pull over what's left this week and charges nothing", async () => {
    const wallet = new InMemoryWalletAdapter(() => new Date("2026-11-18T12:00:00Z"));
    await wallet.pull({ from: tristan, to, amount: usdc(30), idempotencyKey: "a" });
    const result = await wallet.pull({ from: tristan, to, amount: usdc(25), idempotencyKey: "b" });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.reason).toContain("$20.00 left this week");
    expect((await wallet.getLimitStatus(tristan)).remaining).toBe(usdc(20));
  });

  it("never double-charges a retried pull", async () => {
    const wallet = new InMemoryWalletAdapter(() => new Date("2026-11-18T12:00:00Z"));
    await wallet.pull({ from: tristan, to, amount: usdc(30), idempotencyKey: "same" });
    await wallet.pull({ from: tristan, to, amount: usdc(30), idempotencyKey: "same" });
    expect((await wallet.getLimitStatus(tristan)).remaining).toBe(usdc(20));
  });

  it("resets on Monday", async () => {
    let now = new Date("2026-11-22T23:00:00Z"); // Sunday
    const wallet = new InMemoryWalletAdapter(() => now);
    await wallet.pull({ from: tristan, to, amount: usdc(50), idempotencyKey: "a" });
    expect((await wallet.canPull(tristan, usdc(1))).ok).toBe(false);
    now = new Date("2026-11-23T01:00:00Z"); // Monday
    expect((await wallet.canPull(tristan, usdc(50))).ok).toBe(true);
  });

  it("finds the start of the period", () => {
    expect(periodStart("weekly", new Date("2026-11-18T12:00:00Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(periodStart("monthly", new Date("2026-11-18T12:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
