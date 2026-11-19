import { afterEach, describe, expect, it, vi } from "vitest";
import { withoutSamplingParams } from "./model.js";

describe("withoutSamplingParams", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops temperature/top_p/top_k, which current Claude models reject", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      seen.push(String(init?.body));
      return new Response("{}");
    });
    await withoutSamplingParams("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5", temperature: 0, top_p: 1, top_k: 5, max_tokens: 10 }),
    });
    expect(JSON.parse(seen[0]!)).toEqual({ model: "claude-sonnet-5", max_tokens: 10 });
  });

  it("passes non-JSON bodies through untouched", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.body);
      return new Response("{}");
    });
    await withoutSamplingParams("https://example.com", { method: "POST", body: "not json" });
    expect(seen).toEqual(["not json"]);
  });
});
