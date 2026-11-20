/**
 * POST /api/stream: the QuickNode Streams webhook destination.
 *
 * The Stream (scripts/create-stream.mts, filter in streams/filter.js) sends every GroupTreasury
 * event on Arc Testnet, plus the USDC transfers in those transactions, as they're mined (and backfilled
 * from the contract's deploy block). Each delivery is checked against the stream's security token
 * (QN_STREAM_SECRET) and stored in Postgres, where the dashboard and the bot read it.
 */
import { db, ensureSchema, rowsFrom, saveRows, sameSecret, signatureVariant } from "./_kitty-db.js";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.QN_STREAM_SECRET ?? "";
  if (!secret) return Response.json({ error: "QN_STREAM_SECRET is not set" }, { status: 500 });

  const body = await request.text();
  const h = request.headers;
  const signature = h.get("x-qn-signature") ?? "";
  // QuickNode's HMAC headers, or the stream's custom header carrying the same secret (QuickNode's
  // "Check connection" sends no signature at all, so the custom header is what that test can pass).
  const variant =
    signatureVariant(secret, h.get("x-qn-nonce") ?? "", h.get("x-qn-timestamp") ?? "", body, signature) ??
    (sameSecret(h.get("x-kitty-secret") ?? "", secret) ? "x-kitty-secret" : undefined);
  // Names and sizes only, never values: enough to see how QuickNode signed a delivery.
  console.log(
    `stream delivery: signature ${variant ?? "no match"}; headers ${[...h.keys()].filter((k) => !/^(x-vercel|x-forwarded|x-real-ip|forwarded)/.test(k)).join(",")}; body ${body.length} B; signature ${signature.length} chars`,
  );
  if (!variant) return Response.json({ error: "bad signature" }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "not JSON" }, { status: 400 });
  }

  const rows = rowsFrom(payload);
  try {
    const sql = db();
    await ensureSchema(sql);
    await saveRows(sql, rows);
  } catch (err) {
    // A 5xx makes QuickNode retry the same batch, which the primary keys make safe.
    console.error("stream save failed", err);
    return Response.json({ error: "couldn't save" }, { status: 503 });
  }
  return Response.json({ logs: rows.logs.length, transfers: rows.transfers.length });
}
