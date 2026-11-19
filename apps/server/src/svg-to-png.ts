/**
 * iMessage sends an .svg as a file, not a picture, so checkout cards are converted to PNG first.
 * resvg is a self-contained renderer (no browser, no system libraries).
 */

import { readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import type { ImageRef } from "@gta/core";

/** Returns a PNG version of an SVG image (written next to it), or the image unchanged. */
export async function asPng(image: ImageRef): Promise<ImageRef> {
  if (!image.uri.toLowerCase().endsWith(".svg")) return image;
  // resvg can't draw color emoji, and one in a line turns the whole line into boxes; the chat card
  // next to the image carries the 👍 anyway.
  const svg = (await readFile(image.uri, "utf8"))
    .replace(/👍\uFE0F?/gu, "a thumbs-up")
    .replace(/\s*\p{Extended_Pictographic}\uFE0F?/gu, "");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true } }).render().asPng();
  const uri = image.uri.replace(/\.svg$/i, ".png");
  await writeFile(uri, png);
  return { uri, mimeType: "image/png" };
}
