/**
 * Kitty's public signing keys for Crossmint ("Custom tokens"), as a function so each fetch is
 * logged: if Crossmint says it can't find a key, the Vercel logs show whether it ever asked.
 * Same keys as public/.well-known/jwks.json.
 */
import jwks from "../public/.well-known/jwks.json" with { type: "json" };

export function GET(request: Request): Response {
  console.log(`jwks fetched by ${request.headers.get("user-agent") ?? "?"}`);
  return Response.json(jwks, { headers: { "Cache-Control": "no-store" } });
}
