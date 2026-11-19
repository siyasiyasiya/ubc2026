/**
 * Runs the Arc adapter against the real GroupTreasury contract on a local anvil chain.
 * Skipped when Foundry (anvil + forge) isn't installed.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usdc, type Member } from "@gta/core";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArcWalletAdapter, groupIdForChat } from "./arc.js";

const contractsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts");
const hasFoundry = (() => {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// anvil's well-known dev keys
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3ae0d4d0d8b14b6c",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;
const [operator, alice, bob, carol] = KEYS.map((k) => privateKeyToAccount(k));
const CHAT = "chat-123";
const PORT = 8545 + Math.floor(Math.random() * 1000);

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(path.join(contractsDir, "out", file, `${name}.json`), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

function member(id: string, wallet?: Address): Member {
  return {
    id,
    displayName: id,
    handle: { kind: "phone", value: id },
    ...(wallet ? { wallet: { address: wallet } } : {}),
    limit: { amount: usdc(50), period: "weekly" },
  };
}

describe.skipIf(!hasFoundry)("ArcWalletAdapter on anvil", () => {
  let anvil: ChildProcess;
  let publicClient: PublicClient;
  let treasury: Address;
  let token: Address;
  let tokenAbi: Abi;
  const transport = http(`http://127.0.0.1:${PORT}`);
  const walletFor = (account: (typeof KEYS)[number]) =>
    createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(account) });
  const makeAdapter = () =>
    new ArcWalletAdapter({ treasury, chatId: CHAT, publicClient, walletClient: walletFor(KEYS[0]) });
  const balance = (who: Address) =>
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

  async function send(key: (typeof KEYS)[number], address: Address, abi: Abi, functionName: string, args: unknown[]) {
    const hash = await walletFor(key).writeContract({ address, abi, functionName, args });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function deploy(key: (typeof KEYS)[number], { abi, bytecode }: { abi: Abi; bytecode: Hex }, args: unknown[]) {
    const hash = await walletFor(key).deployContract({ abi, bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  }

  beforeAll(async () => {
    execFileSync("forge", ["build"], { cwd: contractsDir, stdio: "ignore" });
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    publicClient = createPublicClient({ chain: foundry, transport }) as PublicClient;
    for (let i = 0; ; i++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        if (i > 50) throw new Error("anvil didn't start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const mock = artifact("GroupTreasury.t.sol", "MockUSDC");
    const gt = artifact("GroupTreasury.sol", "GroupTreasury");
    tokenAbi = mock.abi;
    token = await deploy(KEYS[0], mock, []);
    treasury = await deploy(KEYS[0], gt, [token, operator!.address]);

    // Alice joins this chat with a $50/week limit and approves the treasury on USDC.
    await send(KEYS[0], token, tokenAbi, "mint", [alice!.address, usdc(100)]);
    await send(KEYS[1], token, tokenAbi, "approve", [treasury, usdc(1000)]);
    await send(KEYS[1], treasury, gt.abi, "join", [groupIdForChat(CHAT), usdc(50), 0, `0x${"11".repeat(32)}`]);
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  const to = () => ({ kind: "wallet" as const, address: bob!.address });

  it("reads the limit the member signed onchain", async () => {
    const status = await makeAdapter().getLimitStatus(member("alice", alice!.address));
    expect(status.limit).toMatchObject({ amount: usdc(50), period: "weekly" });
    expect(status.remaining).toBe(usdc(50));
    expect(status.resetsAt).toBeGreaterThan(Date.now());
  });

  it("pulls a share to the payer and counts it against the limit", async () => {
    const adapter = makeAdapter();
    const outcome = await adapter.pull({ from: member("alice", alice!.address), to: to(), amount: usdc(30), idempotencyKey: "r1:alice" });
    expect(outcome.status).toBe("pulled");
    expect(outcome.txRef).toMatch(/^0x/);
    expect(await balance(bob!.address)).toBe(usdc(30));
    expect((await adapter.canPull(member("alice", alice!.address), usdc(30))).remaining).toBe(usdc(20));
  });

  it("never pulls twice for the same idempotency key, even after a restart", async () => {
    const first = await makeAdapter().pull({ from: member("alice", alice!.address), to: to(), amount: usdc(30), idempotencyKey: "r1:alice" });
    expect(first.status).toBe("pulled");
    expect(await balance(bob!.address)).toBe(usdc(30));
  });

  it("records an over-limit share as a failed pull (and an onchain debt)", async () => {
    const outcome = await makeAdapter().pull({ from: member("alice", alice!.address), to: to(), amount: usdc(25), idempotencyKey: "r2:alice" });
    expect(outcome).toMatchObject({ status: "failed", reason: "over limit" });
    expect(await balance(bob!.address)).toBe(usdc(30));
    const debt = await publicClient.readContract({
      address: treasury,
      abi: artifact("GroupTreasury.sol", "GroupTreasury").abi,
      functionName: "debts",
      args: [alice!.address, bob!.address],
    });
    expect(debt).toBe(usdc(25));
  });

  it("fails without touching the chain when someone hasn't linked or joined", async () => {
    const adapter = makeAdapter();
    expect(await adapter.pull({ from: member("dan"), to: to(), amount: usdc(5), idempotencyKey: "r3:dan" })).toMatchObject({
      status: "failed",
      reason: "hasn't linked a wallet yet",
    });
    expect(await adapter.pull({ from: member("carol", carol!.address), to: to(), amount: usdc(5), idempotencyKey: "r3:carol" })).toMatchObject({
      status: "failed",
      reason: "hasn't joined this chat's treasury",
    });
    expect(
      await adapter.pull({ from: member("alice", alice!.address), to: { kind: "card", reference: "bob" }, amount: usdc(5), idempotencyKey: "r3:alice" }),
    ).toMatchObject({ status: "failed", reason: "payer hasn't linked a wallet yet" });
    expect((await adapter.getLimitStatus(member("carol", carol!.address))).remaining).toBe(usdc(0));
  });
});
