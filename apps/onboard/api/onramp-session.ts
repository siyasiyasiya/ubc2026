/**
 * POST /api/onramp-session { address } -> { widgetUrl }
 *
 * Mints an Arc Onramp session (Apple Pay / debit card -> USDC on Arc) that delivers straight to
 * the member's own Kitty account. Runs server-side because the Circle API key grants full access
 * to the Onramp integration. Kitty never receives the money: the destination is the member.
 */

import { createAppServerKit } from "@circle-fin/app-kit/server";

const sandbox = process.env.ONRAMP_ENV !== "production";
const server = createAppServerKit({
  onramp: {
    apiKey: process.env.CIRCLE_API_KEY ?? "",
    referrerDomain: process.env.ONRAMP_REFERRER_DOMAIN ?? "kittyagent.vercel.app",
    ...(sandbox ? { baseUrl: "https://api-test.circle.com", widgetBaseUrl: "https://onramp-sandbox.arc.io" } : {}),
  },
});

export async function POST(request: Request): Promise<Response> {
  let address: unknown;
  try {
    ({ address } = (await request.json()) as { address?: unknown });
  } catch {
    return Response.json({ error: "Send JSON like { address }." }, { status: 400 });
  }
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return Response.json({ error: "address must be a 0x-prefixed 20-byte hex address" }, { status: 400 });
  }
  try {
    const session = await server.onramp.createSession({
      appUserId: address.toLowerCase(),
      destinationAddress: address,
      assets: { tokens: ["USDC"], chains: ["arc"] },
    });
    return Response.json({ widgetUrl: session.widgetUrl, expiresAt: session.expiresAt });
  } catch (err) {
    console.error("onramp session failed", err);
    return Response.json({ error: "Couldn't start a top-up right now." }, { status: 502 });
  }
}
