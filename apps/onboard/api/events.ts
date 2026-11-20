/**
 * GET /api/events?after=<block>:<logIndex> -> { logs, lastBlock }: treasury events from the
 * QuickNode Stream, oldest first, up to 1000 at a time. Kitty's bot reads this instead of polling
 * the chain. Needs `Authorization: Bearer <EVENTS_SECRET>`.
 */
import { db, lastBlock, treasuryLogs } from "./_kitty-db.js";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.EVENTS_SECRET ?? "";
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const after = /^(\d{1,12}):(\d{1,6})$/.exec(new URL(request.url).searchParams.get("after") ?? "");
  try {
    const sql = db();
    const [logs, block] = await Promise.all([
      treasuryLogs(sql, after ? { block: BigInt(after[1]!), logIndex: Number(after[2]) } : { block: 0n, logIndex: -1 }),
      lastBlock(sql),
    ]);
    return Response.json({ logs, lastBlock: block }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("events read failed", err);
    return Response.json({ error: "stream store unavailable" }, { status: 503 });
  }
}
