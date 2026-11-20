import { usdc } from "@gta/core";
import { describe, expect, it } from "vitest";
import { Store } from "./store.js";

const OLD = "0x1E383fe0098f3dE2530b42f1c8172CA2BC547320";
const NEW = "0xAF2b75eda3c50358Ce754b93c60F76F0871bE235";

function withMembers(): Store {
  const store = new Store();
  store.put({
    group: {
      id: "g",
      kind: "friends",
      name: "Roommates",
      chatId: "g",
      members: [
        { id: "+1", displayName: "Siya", handle: { kind: "phone", value: "+1" }, wallet: { address: "0xaa" }, limit: { amount: usdc(10), period: "weekly" } },
        { id: "+2", displayName: "Joey", handle: { kind: "phone", value: "+2" }, limit: { amount: usdc(10), period: "weekly" } },
      ],
    },
    requests: [],
    plan: { amount: usdc(10), period: "weekly" },
  });
  store.joinCursor = 123n;
  store.saveCard("+1", { userId: "kitty-1", paymentMethodId: "pm_1", at: 0 });
  return store;
}

describe("Store.useTreasury", () => {
  it("clears account links and the join cursor when the contract changes, keeping the rest", () => {
    const store = withMembers();
    expect(store.useTreasury(NEW)).toBe(1);
    const record = store.get("g")!;
    expect(record.group.members.every((m) => !m.wallet)).toBe(true);
    expect(store.joinCursor).toBeUndefined();
    expect(record.plan).toEqual({ amount: usdc(10), period: "weekly" });
    expect(store.card("+1")?.paymentMethodId).toBe("pm_1");
  });

  it("does nothing on the same contract (any letter case)", () => {
    const store = withMembers();
    store.useTreasury(OLD);
    store.get("g")!.group.members[0]!.wallet = { address: "0xaa" };
    store.joinCursor = 456n;
    expect(store.useTreasury(OLD.toLowerCase())).toBe(0);
    expect(store.get("g")!.group.members[0]!.wallet).toEqual({ address: "0xaa" });
    expect(store.joinCursor).toBe(456n);
  });
});
