/**
 * POST /api/test-money { address } -> { added, balance, tx }
 *
 * Testnet only: the add-money page's "Add $20 test money" button. Sends test USDC on Arc from a
 * small faucet wallet (TESTNET_FAUCET_PRIVATE_KEY), not the bot's operator key, so this public
 * endpoint can never touch the bot's funds or collide with its nonces. Refill the faucet with
 * `pnpm --filter @gta/server fund <faucet address> 100`.
 *
 * No database, so the cap is stateless: it only tops up accounts holding under $10, which keeps
 * one account from draining the faucet. Off unless the key is set.
 */

import { createPublicClient, createWalletClient, getAddress, http, isAddress, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const AMOUNT_USD = Number(process.env.TESTNET_TOPUP_USD ?? 20);
const ONLY_UNDER_USD = 10;
// Arc's native currency is USDC with 18 decimals.
const toWei = (usd: number) => parseUnits(usd.toFixed(2), 18);
const toUsd = (wei: bigint) => Number(wei / 10n ** 16n) / 100;

/** GET -> { on }: the page shows the button only when the faucet is configured. */
export function GET(): Response {
  return Response.json({ on: Boolean(process.env.TESTNET_FAUCET_PRIVATE_KEY) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const key = process.env.TESTNET_FAUCET_PRIVATE_KEY as Hex | undefined;
  if (!key) return Response.json({ error: "Test money is off." }, { status: 404 });

  let address: unknown;
  try {
    ({ address } = (await request.json()) as { address?: unknown });
  } catch {
    return Response.json({ error: "Send JSON like { address }." }, { status: 400 });
  }
  if (typeof address !== "string" || !isAddress(address)) {
    return Response.json({ error: "address must be a 0x-prefixed 20-byte hex address" }, { status: 400 });
  }
  const to = getAddress(address);

  const transport = http(process.env.ARC_RPC_URL || undefined);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const walletClient = createWalletClient({ chain: arcTestnet, transport, account: privateKeyToAccount(key) });

  try {
    const before = await publicClient.getBalance({ address: to });
    if (before >= toWei(ONLY_UNDER_USD)) {
      return Response.json(
        { error: `You already have $${toUsd(before).toFixed(2)}. Test money is for balances under $${ONLY_UNDER_USD}.` },
        { status: 409 },
      );
    }
    const tx = await walletClient.sendTransaction({ to, value: toWei(AMOUNT_USD) });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    const balance = await publicClient.getBalance({ address: to });
    console.log(`test money: $${AMOUNT_USD} -> ${to} (${tx})`);
    return Response.json({ added: AMOUNT_USD, balance: toUsd(balance), tx });
  } catch (err) {
    console.error("test money failed", err);
    const empty = /insufficient funds/i.test((err as Error).message);
    return Response.json(
      { error: empty ? "The test faucet is empty. Ask the team to refill it." : "Couldn't send test money right now." },
      { status: 502 },
    );
  }
}
