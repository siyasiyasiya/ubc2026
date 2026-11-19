import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { usdc, type ImageRef, type Receipt, type ReceiptReader } from "@gta/core";
import { z } from "zod";
import { claude, MODEL } from "./claude.js";

const run = promisify(execFile);

const ReceiptSchema = z.object({
  is_receipt: z.boolean().describe("False if the photo is not a receipt or bill"),
  merchant: z.string().describe("Business name, or empty if unknown"),
  subtotal: z.number().describe("Before tax and tip, 0 if not shown"),
  tax: z.number().describe("0 if not shown"),
  tip: z.number().describe("Tip or gratuity on the receipt, 0 if none"),
  total: z.number().describe("Final amount charged, including tax and tip"),
  items: z.array(z.object({ name: z.string(), price: z.number() })),
});

export class NotAReceiptError extends Error {}

/**
 * iPhone photos are often HEIC and can be large; the API takes JPEG/PNG/GIF/WebP up to a size
 * limit. macOS `sips` converts and shrinks any image to a JPEG at most 1600px on its longest side.
 */
async function toJpeg(file: string): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-"));
  try {
    const output = path.join(dir, "out.jpg");
    await run("sips", ["-s", "format", "jpeg", "-Z", "1600", file, "--out", output]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** True when the attachment is a PDF, so it's sent as a document rather than rasterized to an image. */
export function isPdf(file: ImageRef): boolean {
  return file.mimeType === "application/pdf" || file.uri.toLowerCase().endsWith(".pdf");
}

/**
 * The receipt attachment as a Claude content block: a PDF goes as a native document (crisp text,
 * multi-page), any image is converted to a sized JPEG first.
 */
async function receiptBlock(file: ImageRef) {
  if (isPdf(file)) {
    const data = (await fs.readFile(file.uri)).toString("base64");
    return { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } };
  }
  const jpeg = await toJpeg(file.uri);
  return { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: jpeg.toString("base64") } };
}

/** Reads a receipt from a photo or a PDF with Claude and structured output. */
export class ClaudeReceiptReader implements ReceiptReader {
  async read(image: ImageRef): Promise<Receipt> {
    const response = await claude().messages.parse({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(ReceiptSchema) },
      messages: [
        {
          role: "user",
          content: [
            await receiptBlock(image),
            {
              type: "text",
              text: "Read this receipt. Use the amounts printed on it. If a tip is handwritten, use the handwritten tip and total.",
            },
          ],
        },
      ],
    });
    const parsed = response.stop_reason === "refusal" ? null : response.parsed_output;
    if (!parsed?.is_receipt) throw new NotAReceiptError("That photo doesn't look like a receipt");

    return {
      source: "photo",
      ...(parsed.merchant ? { merchant: parsed.merchant } : {}),
      subtotal: usdc(parsed.subtotal),
      tax: usdc(parsed.tax),
      tip: usdc(parsed.tip),
      total: usdc(parsed.total),
      lineItems: parsed.items.map((i) => ({ name: i.name, amount: usdc(i.price) })),
      image,
      at: Date.now(),
    };
  }
}
