import type { Hex } from "viem";
import { describe as suite, expect, it } from "vitest";
import { describe, describePurchase, describeSubscription, subscriptionFor } from "../src/dashboard";
import type { Purchase } from "../src/history";
import { parseSubscription, perMonth, subscriptionsFromLink } from "../src/subscriptions";

const GROUP = `0x${"a1".repeat(32)}` as Hex;
const NEENA = "0x00000000000000000000000000000000000000aa";
// The exact shape apps/server's subscriptionParam writes (its test pins the same string).
const PARAM = `${GROUP}~monthly~a~18000000~6000000~1797710400~${NEENA}~Neena~Spotify Family`;

suite("subscriptions from Kitty's link", () => {
  it("reads the server's param", () => {
    expect(parseSubscription(PARAM)).toEqual({
      group: GROUP,
      title: "Spotify Family",
      every: "monthly",
      pending: false,
      total: 18_000_000n,
      mine: 6_000_000n,
      nextAt: 1797710400,
      payee: NEENA,
      payeeName: "Neena",
    });
  });

  it("keeps a title that has the separator in it, and rejects junk", () => {
    expect(parseSubscription(`${GROUP}~weekly~p~1~0~0~-~-~Rent ~ utilities`)).toMatchObject({ title: "Rent ~ utilities", pending: true, payeeName: "" });
    expect(parseSubscription(`${GROUP}~yearly~a~1~1~0~-~-~X`)).toBeUndefined();
    expect(parseSubscription("0x12~monthly~a~1~1~0~-~-~X")).toBeUndefined();
    expect(parseSubscription(`${GROUP}~monthly~a~1.5~1~0~-~-~X`)).toBeUndefined();
  });

  it("takes the link's list as complete when it says so", () => {
    const params = new URLSearchParams({ sv: "1" });
    params.append("s", PARAM);
    params.append("s", "garbage");
    expect(subscriptionsFromLink(params).map((s) => s.title)).toEqual(["Spotify Family"]);
  });

  it("works out about a month's cost", () => {
    const weekly = parseSubscription(`${GROUP}~weekly~a~30000000~12000000~0~-~-~Cleaner`)!;
    expect(perMonth(weekly)).toBe(52_000_000n); // $12 a week ≈ $52 a month
    expect(perMonth(parseSubscription(PARAM)!)).toBe(6_000_000n);
  });
});

suite("subscriptions on the dashboard", () => {
  const sub = parseSubscription(PARAM)!;
  const charge: Purchase = { id: `0x${"01".repeat(32)}`, group: GROUP, payee: NEENA.toUpperCase().replace("0X", "0x"), total: 18_000_000n, at: 1, status: "paid", approvals: 2, pulled: 12_000_000n, owed: 0n, mine: { amount: 6_000_000n, ok: true }, toMe: 0n };

  it("names a charge after its subscription", () => {
    expect(subscriptionFor(charge, [sub])?.title).toBe("Spotify Family");
    expect(subscriptionFor({ ...charge, total: 9_000_000n }, [sub])).toBeUndefined();
    expect(describePurchase(charge, "0x1111111111111111111111111111111111111111", "Spotify Family").title).toBe("Spotify Family");
  });

  it("shows the subscription row and a named share in activity", () => {
    const rowText = describeSubscription(sub, "Roommates");
    expect(rowText.title).toBe("🔁 Spotify Family");
    expect(rowText.amount).toBe("$6.00/mo");
    expect(rowText.detail).toMatch(/^Roommates · next \w{3} \d+ · \$18 total · paid to Neena$/);
    expect(describeSubscription({ ...sub, pending: true, mine: 0n }, "").detail).toBe("waiting on 👍s to start · $18 total · paid to you");
    const share = describe({ kind: "share", at: 1, tx: `0x${"02".repeat(32)}`, amount: -6_000_000n, group: GROUP }, () => "Roommates", "Spotify Family");
    expect(share).toMatchObject({ title: "Spotify Family", detail: "Roommates · your share", amount: "-$6.00" });
  });
});
