import { beforeEach, describe, expect, it, vi } from "vitest";

// The chain is mocked: these tests never send real test money.
const chain = vi.hoisted(() => ({
  balances: new Map<string, bigint>(),
  sent: [] as { to: string; value: bigint }[],
  failSend: undefined as Error | undefined,
}));

vi.mock("viem", async (importOriginal) => {
  const real = await importOriginal<typeof import("viem")>();
  return {
    ...real,
    createPublicClient: () => ({
      getBalance: async ({ address }: { address: string }) => chain.balances.get(address) ?? 0n,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    }),
    createWalletClient: () => ({
      sendTransaction: async ({ to, value }: { to: string; value: bigint }) => {
        if (chain.failSend) throw chain.failSend;
        chain.sent.push({ to, value });
        chain.balances.set(to, (chain.balances.get(to) ?? 0n) + value);
        return "0xabc";
      },
    }),
  };
});

const { GET, POST } = await import("../api/test-money");

const USD = 10n ** 18n; // Arc's native USDC has 18 decimals.
const ALICE = "0x1111111111111111111111111111111111111111";
const FAUCET_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://kitty/api/test-money", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  chain.balances.clear();
  chain.sent.length = 0;
  chain.failSend = undefined;
  vi.stubEnv("TESTNET_FAUCET_PRIVATE_KEY", FAUCET_KEY);
  vi.stubEnv("TESTNET_TOPUP_USD", "");
});

describe("/api/test-money", () => {
  it("is off without a faucet key", async () => {
    vi.stubEnv("TESTNET_FAUCET_PRIVATE_KEY", "");
    expect(await GET().json()).toEqual({ on: false });
    expect((await post({ address: ALICE })).status).toBe(404);
    expect(chain.sent).toEqual([]);
  });

  it("says it's on when the key is set", async () => {
    expect(await GET().json()).toEqual({ on: true });
  });

  it("adds $20 to a low balance and returns the new balance", async () => {
    chain.balances.set(ALICE, 3n * USD);
    const res = await post({ address: ALICE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 20, balance: 23, tx: "0xabc" });
    expect(chain.sent).toEqual([{ to: ALICE, value: 20n * USD }]);
  });

  it("tops up again on every tap, whatever the balance", async () => {
    chain.balances.set(ALICE, 100n * USD);
    expect((await post({ address: ALICE })).status).toBe(200);
    const res = await post({ address: ALICE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 20, balance: 140, tx: "0xabc" });
    expect(chain.sent).toHaveLength(2);
  });

  it("uses TESTNET_TOPUP_USD when set", async () => {
    vi.stubEnv("TESTNET_TOPUP_USD", "5");
    expect(await (await post({ address: ALICE })).json()).toMatchObject({ added: 5, balance: 5 });
  });

  it("rejects a bad address or body", async () => {
    expect((await post({ address: "nope" })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect(chain.sent).toEqual([]);
  });

  it("says the faucet is empty when it can't pay", async () => {
    chain.failSend = new Error("insufficient funds for gas * price + value");
    const res = await post({ address: ALICE });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("faucet is empty");
  });
});
