import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory stand-in for Neon: the tagged template sees "insert" or "select" and acts on a map.
const store = vi.hoisted(() => new Map<string, { url: string; title: string; sub: string }>());
vi.mock("../api/_kitty-db.js", () => ({
  db: () => async (strings: TemplateStringsArray, ...values: string[]) => {
    const q = strings.join("?");
    if (q.includes("insert")) store.set(values[0]!, { url: values[1]!, title: values[2]!, sub: values[3]! });
    if (q.includes("select")) return store.has(values[0]!) ? [store.get(values[0]!)] : [];
    return [];
  },
}));

const { GET, POST, newCode, previewHtml } = await import("../api/link");

const IMESSAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function create(body: unknown, auth = "Bearer s3cret"): Promise<Response> {
  return POST(new Request("https://kitty.test/api/link", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) }));
}
function open(code: string, ua: string): Promise<Response> {
  return GET(new Request(`https://kitty.test/api/link?code=${code}`, { headers: { "user-agent": ua } }));
}

beforeEach(() => {
  store.clear();
  process.env.EVENTS_SECRET = "s3cret";
  process.env.DATABASE_URL = "postgres://test";
});

describe("short links", () => {
  it("only the bot can create one", async () => {
    expect((await create({ url: "https://kitty.test/?t=1", title: "Join" }, "Bearer nope")).status).toBe(401);
    expect((await create({ url: "http://evil.test", title: "Join" })).status).toBe(400);
  });

  it("shows iMessage a card that says what the link does, and sends people to the real page", async () => {
    const res = await create({ url: "https://kitty.test/?t=abc&c=Tahoe", title: "Join Tahoe trip · $200 each", sub: "Tap to confirm" });
    const { code, url } = (await res.json()) as { code: string; url: string };
    expect(url).toBe(`https://kitty.test/k/${code}`);

    const preview = await open(code, IMESSAGE_UA);
    const html = await preview.text();
    expect(html).toContain('<meta property="og:title" content="Join Tahoe trip · $200 each" />');
    expect(html).toContain('content="Tap to confirm"');
    expect(html).not.toContain("og:image");

    const person = await open(code, IPHONE_UA);
    expect(person.status).toBe(302);
    expect(person.headers.get("location")).toBe("https://kitty.test/?t=abc&c=Tahoe");
  });

  it("an unknown code goes home", async () => {
    const res = await open("doesnotexist", IPHONE_UA);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://kitty.test/");
  });

  it("escapes titles and makes unguessable codes", () => {
    expect(previewHtml("https://k", { url: "https://k", title: '<b>"x"</b>', sub: "" })).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(newCode()).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(newCode()).not.toBe(newCode());
  });
});
