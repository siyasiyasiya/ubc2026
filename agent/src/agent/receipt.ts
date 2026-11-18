import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { claude, MODEL } from "./claude.js";

const run = promisify(execFile);

export const ReceiptSchema = z.object({
  is_receipt: z.boolean().describe("False if the photo is not a receipt or bill"),
  merchant: z.string().describe("Business name, or empty if unknown"),
  currency: z.string().describe("ISO code, e.g. USD"),
  subtotal: z.number().describe("Before tax and tip, 0 if not shown"),
  tax: z.number().describe("0 if not shown"),
  tip: z.number().describe("Tip or gratuity written on the receipt, 0 if none"),
  total: z.number().describe("Final amount charged, including tax and tip"),
  items: z.array(z.object({ name: z.string(), price: z.number() })),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/**
 * iPhone photos are often HEIC and can be large; the API takes JPEG/PNG/GIF/WebP up to a size limit.
 * macOS `sips` converts and shrinks any image to a JPEG at most 1600px on its longest side.
 */
async function toJpeg(bytes: Buffer): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-"));
  try {
    const input = path.join(dir, "in");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, bytes);
    await run("sips", ["-s", "format", "jpeg", "-Z", "1600", input, "--out", output]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Reads a receipt photo into structured totals. Returns null if Claude couldn't produce a result. */
export async function readReceipt(bytes: Buffer): Promise<Receipt | null> {
  const jpeg = await toJpeg(bytes);
  const response = await claude().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(ReceiptSchema) },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
          },
          {
            type: "text",
            text: "Read this receipt. Use the amounts printed on it. If a tip line is handwritten, use the handwritten tip and total.",
          },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") return null;
  return response.parsed_output ?? null;
}
