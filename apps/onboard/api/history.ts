/**
 * GET /api/history?account=0x… -> { logs, transfers, lastBlock } from the QuickNode Stream's tables.
 *
 * Same rows the explorer API returns (every treasury log, plus this account's USDC transfers seen
 * in treasury transactions), without its per-IP rate limit. An empty table answers 404 so the
 * page falls back to the explorer instead of showing a blank history.
 */
import { isAddress } from "viem";
import { accountTransfers, db, lastBlock, treasuryLogs } from "./_kitty-db.js";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const account = params.get("account") ?? "";
  if (!isAddress(account)) return Response.json({ error: "account must be an address" }, { status: 400 });
  // The store holds one contract's events (the one the Stream filters on): any other is the explorer's job.
  const treasury = params.get("treasury");
  const streamed = process.env.VITE_TREASURY_ADDRESS ?? "";
  if (treasury && streamed && treasury.toLowerCase() !== streamed.toLowerCase()) {
    return Response.json({ error: "not this contract" }, { status: 404 });
  }
  try {
    const sql = db();
    const [logs, transfers, block] = await Promise.all([treasuryLogs(sql), accountTransfers(sql, account), lastBlock(sql)]);
    if (!logs.length) return Response.json({ error: "no stream data yet" }, { status: 404 });
    return Response.json(
      { logs, transfers, lastBlock: block },
      { headers: { "cache-control": "public, s-maxage=5, stale-while-revalidate=60" } },
    );
  } catch (err) {
    console.error("history read failed", err);
    return Response.json({ error: "stream store unavailable" }, { status: 503 });
  }
}
