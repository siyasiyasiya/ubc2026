/**
 * Short links that look like a compact card in iMessage, e.g. kittyagent.vercel.app/k/x7Kp2aQ9.
 *
 * POST /api/link { url, title, sub } -> { code }   (Authorization: Bearer <EVENTS_SECRET>, the bot only)
 * GET  /k/<code>  (vercel.json rewrites it to /api/link?code=<code>)
 *   - iMessage's preview fetcher (it sends facebookexternalhit/Twitterbot in its user agent) gets a tiny
 *     page whose meta tags say what this link does ("Join Tahoe trip · $200 each" / "Tap to confirm")
 *     and a small square icon, so Messages draws a slim card instead of the big banner.
 *   - Everyone else is redirected to the real page.
 */
import { randomBytes } from "node:crypto";
import { db } from "./_kitty-db.js";
import type { NeonQueryFunction } from "@neondatabase/serverless";

const CODE = /^[A-Za-z0-9]{6,16}$/;
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PREVIEW_BOT = /facebookexternalhit|Facebot|Twitterbot|Slackbot|WhatsApp|TelegramBot|Discordbot|LinkedInBot|Googlebot/i;

/** 10 characters from a 56-letter alphabet (~58 bits): links carry private tickets, so codes must not be guessable. */
export function newCode(): string {
  return [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

let ready: Promise<unknown> | undefined;
function ensureTable(sql: NeonQueryFunction<false, false>): Promise<unknown> {
  ready ??= sql`create table if not exists kitty_links (
      code text primary key, url text not null, title text not null, sub text not null,
      created_at timestamptz not null default now())`.catch((err: unknown) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page the preview fetcher reads. No og:image on purpose: with only a square icon, Messages draws the compact card. */
export function previewHtml(origin: string, link: { url: string; title: string; sub: string }): string {
  const title = escape(link.title);
  const sub = escape(link.sub);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${title}</title>
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${sub}" />
<meta property="og:site_name" content="Kitty" />
<meta name="description" content="${sub}" />
<link rel="icon" type="image/png" href="${origin}/icon.png" />
<link rel="apple-touch-icon" href="${origin}/icon.png" />
</head><body><a href="${escape(link.url)}">${title}</a></body></html>`;
}

export async function GET(request: Request): Promise<Response> {
  const req = new URL(request.url);
  const code = req.searchParams.get("code") ?? "";
  const home = new URL("/", req.origin).toString();
  if (!CODE.test(code)) return Response.redirect(home, 302);
  let row: { url: string; title: string; sub: string } | undefined;
  try {
    const sql = db();
    await ensureTable(sql);
    row = ((await sql`select url, title, sub from kitty_links where code = ${code}`) as typeof row[])[0];
  } catch (err) {
    console.error("link read failed", err);
    return new Response("Kitty is having a moment, try again in a sec.", { status: 503 });
  }
  if (!row) return Response.redirect(home, 302);
  if (PREVIEW_BOT.test(request.headers.get("user-agent") ?? "")) {
    return new Response(previewHtml(req.origin, row), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
    });
  }
  return new Response(null, { status: 302, headers: { location: row.url, "cache-control": "private, no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.EVENTS_SECRET ?? "";
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { url?: unknown; title?: unknown; sub?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Send JSON like { url, title, sub }." }, { status: 400 });
  }
  const { url, title, sub } = body;
  if (typeof url !== "string" || !/^https:\/\//.test(url) || typeof title !== "string" || !title.trim()) {
    return Response.json({ error: "url (https) and title are required" }, { status: 400 });
  }
  const code = newCode();
  try {
    const sql = db();
    await ensureTable(sql);
    await sql`insert into kitty_links (code, url, title, sub) values (${code}, ${url}, ${title.slice(0, 120)}, ${typeof sub === "string" ? sub.slice(0, 200) : ""})`;
  } catch (err) {
    console.error("link write failed", err);
    return Response.json({ error: "link store unavailable" }, { status: 503 });
  }
  return Response.json({ code, url: new URL(`/k/${code}`, new URL(request.url).origin).toString() });
}
