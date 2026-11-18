/**
 * Unit tests for the agent's Claude wiring.
 *
 * These exercise the REAL `generateObject` path end-to-end: a `MockLanguageModelV1`
 * (from `ai/test`) stands in for Claude, so the AI SDK still builds the request,
 * decodes the model's JSON against our Zod schema, and hands back the typed
 * object — no network call, no API key needed.
 */

import type { ImageRef, Request } from "@gta/core";
import { usdc } from "@gta/core";
import { MockLanguageModelV1 } from "ai/test";
import { describe, expect, it } from "vitest";

import { ClaudeReceiptReader, parseRequest } from "./index.js";

/**
 * Build a mock Claude model whose structured-output JSON is `payload`. Setting
 * `defaultObjectGenerationMode: "json"` makes `generateObject` take its JSON
 * path and parse `text` — the same path the real model uses.
 */
function mockModel(payload: unknown): { model: MockLanguageModelV1; lastPrompt: () => unknown } {
  let captured: unknown;
  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async (options) => {
      captured = options.prompt;
      return {
        text: JSON.stringify(payload),
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 20 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, lastPrompt: () => captured };
}

function request(text: string): Request {
  return {
    id: "req_1",
    groupId: "grp_1",
    requesterId: "mem_1",
    text,
    flow: "pay_before",
    createdAt: Date.now(),
  };
}

describe("parseRequest", () => {
  it("parses a pay_before supply request into a valid ParsedIntent", async () => {
    const { model, lastPrompt } = mockModel({
      flow: "pay_before",
      items: [{ name: "paper towels", quantity: 2 }],
      store: "Costco",
      notes: "kitchen supplies",
    });

    const intent = await parseRequest(request("we're out of paper towels"), { model });

    expect(intent.flow).toBe("pay_before");
    expect(intent.items).toEqual([{ name: "paper towels", quantity: 2 }]);
    expect(intent.store).toBe("Costco");
    expect(intent.notes).toBe("kitchen supplies");

    // Confirms the real generateObject wiring ran: the user's text reached the model.
    expect(JSON.stringify(lastPrompt())).toContain("paper towels");
  });

  it("parses a pay_after plan (no items) into a valid ParsedIntent", async () => {
    const { model } = mockModel({
      flow: "pay_after",
      store: "Uchi",
      notes: "dinner Friday",
    });

    const intent = await parseRequest(request("dinner at Uchi Friday?"), { model });

    expect(intent.flow).toBe("pay_after");
    expect(intent.store).toBe("Uchi");
    expect(intent.items).toBeUndefined();
  });

  it("rejects an invalid flow value from the model (schema is enforced)", async () => {
    const { model } = mockModel({ flow: "pay_whenever" });
    await expect(parseRequest(request("huh"), { model })).rejects.toThrow();
  });
});

describe("ClaudeReceiptReader", () => {
  const image: ImageRef = { uri: "https://example.com/receipt.jpg", mimeType: "image/jpeg" };

  it("maps model output to a valid Receipt with correct Usdc conversion", async () => {
    const { model } = mockModel({
      merchant: "Uchi",
      subtotal: 80.0,
      tax: 6.6,
      tip: 16.0,
      total: 102.6,
      lineItems: [
        { name: "Hama Chili", amount: 18.0 },
        { name: "Sake", amount: 22.5 },
      ],
    });

    const receipt = await new ClaudeReceiptReader({ model }).read(image);

    expect(receipt.source).toBe("photo");
    expect(receipt.merchant).toBe("Uchi");
    expect(receipt.image).toBe(image);
    expect(typeof receipt.at).toBe("number");

    // Money is micro-USDC bigint, converted via core's usdc() helper.
    expect(receipt.total).toBe(usdc(102.6));
    expect(receipt.total).toBe(102_600_000n);
    expect(typeof receipt.total).toBe("bigint");
    expect(receipt.subtotal).toBe(usdc(80));
    expect(receipt.tax).toBe(usdc(6.6));
    expect(receipt.tip).toBe(usdc(16));

    expect(receipt.lineItems).toEqual([
      { name: "Hama Chili", amount: usdc(18) },
      { name: "Sake", amount: usdc(22.5) },
    ]);
  });

  it("handles a receipt with only a total (optional fields omitted)", async () => {
    const { model } = mockModel({ total: 12.5 });

    const receipt = await new ClaudeReceiptReader({ model }).read(image);

    expect(receipt.total).toBe(usdc(12.5));
    expect(receipt.subtotal).toBeUndefined();
    expect(receipt.tax).toBeUndefined();
    expect(receipt.tip).toBeUndefined();
    expect(receipt.lineItems).toBeUndefined();
  });
});
