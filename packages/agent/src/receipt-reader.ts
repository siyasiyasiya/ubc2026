/**
 * ClaudeReceiptReader — implements core's `ReceiptReader` port using Claude
 * VISION via the Vercel AI SDK. It reads a receipt photo and extracts the
 * merchant, money fields, and line items into a typed `Receipt`.
 *
 * All money is `Usdc` (micro-USDC bigint). The model reports plain dollar
 * amounts; we convert each through core's `usdc()` helper so we never touch
 * floats downstream.
 */

import { readFile } from "node:fs/promises";

import type { ImageRef, Receipt, ReceiptLineItem, ReceiptReader } from "@gta/core";
import { usdc } from "@gta/core";
import { generateObject, type ImagePart, type LanguageModelV1 } from "ai";
import { z } from "zod";

import { defaultModel } from "./model.js";

/**
 * Zod schema for the raw receipt the model returns. Money fields are plain
 * dollar numbers (e.g. 12.50) — we convert them to `Usdc` after decoding.
 */
const receiptSchema = z.object({
  merchant: z.string().optional().describe("The store or restaurant name on the receipt."),
  subtotal: z
    .number()
    .nonnegative()
    .optional()
    .describe("Pre-tax subtotal in dollars, e.g. 42.00."),
  tax: z.number().nonnegative().optional().describe("Tax in dollars."),
  tip: z.number().nonnegative().optional().describe("Tip / gratuity in dollars, if present."),
  total: z
    .number()
    .nonnegative()
    .describe("The grand total actually charged, in dollars. Always present."),
  lineItems: z
    .array(
      z.object({
        name: z.string().describe("The line item label as printed."),
        amount: z.number().describe("The line item price in dollars."),
      }),
    )
    .optional()
    .describe("Individual purchased items with their prices, if legible."),
});

const SYSTEM_PROMPT =
  "You read a photo of a purchase receipt and extract its contents precisely. " +
  "Report every money value as a plain dollar amount (e.g. 12.50, not '$12.50'). " +
  "The total is the final amount charged. If a field (tax, tip, subtotal, line " +
  "items) is not legible or not present, omit it. Do not guess or fabricate values.";

export interface ClaudeReceiptReaderOptions {
  /**
   * Inject a specific model instance (defaults to the configured Claude model).
   * Tests pass a mock here so no network call is made.
   */
  model?: LanguageModelV1;
}

export class ClaudeReceiptReader implements ReceiptReader {
  private readonly model: LanguageModelV1;

  constructor(options: ClaudeReceiptReaderOptions = {}) {
    this.model = options.model ?? defaultModel();
  }

  async read(image: ImageRef): Promise<Receipt> {
    const imagePart = await toImagePart(image);

    const { object } = await generateObject({
      model: this.model,
      schema: receiptSchema,
      schemaName: "Receipt",
      schemaDescription: "The structured contents of a receipt photo.",
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the receipt in this photo." },
            imagePart,
          ],
        },
      ],
    });

    const lineItems: ReceiptLineItem[] | undefined = object.lineItems?.map((item) => ({
      name: item.name,
      amount: usdc(item.amount),
    }));

    return {
      source: "photo",
      merchant: object.merchant,
      subtotal: object.subtotal === undefined ? undefined : usdc(object.subtotal),
      tax: object.tax === undefined ? undefined : usdc(object.tax),
      tip: object.tip === undefined ? undefined : usdc(object.tip),
      total: usdc(object.total),
      lineItems,
      image,
      at: Date.now(),
    };
  }
}

/**
 * Resolve an `ImageRef` into an AI SDK image content part. The `uri` is an
 * opaque locator: an http(s) URL, a `data:` URI, or a local file path. URLs and
 * data URIs pass straight through; a file path is read into bytes.
 */
async function toImagePart(image: ImageRef): Promise<ImagePart> {
  const { uri, mimeType } = image;

  if (/^https?:\/\//i.test(uri)) {
    return { type: "image", image: new URL(uri), mimeType };
  }

  if (uri.startsWith("data:")) {
    return { type: "image", image: uri, mimeType };
  }

  const bytes = await readFile(uri);
  return { type: "image", image: bytes, mimeType };
}
