/**
 * GET /api/explorer?<Arcscan query> -> the Arc explorer's reply, cached at Vercel's edge.
 *
 * The dashboard's history comes from the explorer, which rate-limits each IP without a key. A
 * room of phones on one Wi-Fi shares an IP, and every member reads the same treasury log list, so
 * this passes the two queries the page makes through one cached copy. Nothing else is forwarded.
 * Set ARCSCAN_API_KEY (optional, from dev.blockscout.com) for a higher limit.
 */

import { isAddress } from "viem";

const EXPLORER_API = "https://explorer.testnet.arc.io/api";
const USDC_ERC20 = "0x3600000000000000000000000000000000000000";

/** Only the treasury's log list and one account's USDC transfers, with the page's own paging. */
export function allowedQuery(params: URLSearchParams): URLSearchParams | undefined {
  const address = params.get("address") ?? "";
  if (!isAddress(address)) return undefined;
  const page = params.get("page") ?? "1";
  const offset = params.get("offset") ?? "1000";
  if (!/^\d{1,2}$/.test(page) || !/^\d{1,4}$/.test(offset)) return undefined;
  const module = params.get("module");
  const action = params.get("action");
  if (module === "logs" && action === "getLogs") {
    return new URLSearchParams({ module, action, address, fromBlock: "0", toBlock: "latest", page, offset });
  }
  if (module === "account" && action === "tokentx") {
    return new URLSearchParams({ module, action, address, contractaddress: USDC_ERC20, sort: "desc", page, offset });
  }
  return undefined;
}

export async function GET(request: Request): Promise<Response> {
  const query = allowedQuery(new URL(request.url).searchParams);
  if (!query) return Response.json({ status: "0", message: "Unsupported query", result: null }, { status: 400 });
  const key = process.env.ARCSCAN_API_KEY;
  if (key) query.set("apikey", key);
  try {
    const res = await fetch(`${EXPLORER_API}?${query}`);
    const body = await res.text();
    // Busy or failed replies aren't cached, so the next tap tries again.
    const cache = res.ok ? "public, s-maxage=15, stale-while-revalidate=300" : "no-store";
    return new Response(body, { status: res.status, headers: { "content-type": "application/json", "cache-control": cache } });
  } catch (err) {
    console.error("explorer proxy", err);
    return Response.json({ status: "0", message: "Explorer unreachable", result: null }, { status: 502 });
  }
}
