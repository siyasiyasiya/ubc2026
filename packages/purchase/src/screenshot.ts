/**
 * Checkout screenshot rendering — deliberately isolated behind an interface so
 * it is swappable. The group approves a purchase by 👍-ing this image, so the
 * TOTAL on it must be the real amount that will be charged.
 *
 * Agent Checkouts drives a real browser and exposes a read-only live view at
 * `run.browser.embedUrl` (an iframe, not a static image). There is no documented
 * static-screenshot field, so the default renderer produces a self-contained
 * SVG "checkout summary card" with the real line items + total and no external
 * dependencies. Swap in an HTML→PNG / headless-screenshot renderer later by
 * implementing `CheckoutScreenshotRenderer` — nothing else changes.
 */

import { formatUsdc, type Cart, type ImageRef } from "@gta/core";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScreenshotContext {
  cart: Cart;
  /** Live read-only browser view of the real checkout, when Crossmint exposes
   *  one. A real screenshotting renderer would capture this. */
  embedUrl?: string;
}

export interface CheckoutScreenshotRenderer {
  render(ctx: ScreenshotContext): Promise<ImageRef>;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}

/** Renders the cart to a standalone SVG card with the real total, written to a
 *  temp file. The returned `ImageRef.uri` is that file path. */
export class SummaryCardRenderer implements CheckoutScreenshotRenderer {
  constructor(private readonly outDir?: string) {}

  async render(ctx: ScreenshotContext): Promise<ImageRef> {
    const svg = this.toSvg(ctx.cart);
    const dir = this.outDir ?? (await mkdtemp(join(tmpdir(), "gta-checkout-")));
    const file = join(dir, `checkout-${ctx.cart.id}.svg`);
    await writeFile(file, svg, "utf8");
    return { uri: file, mimeType: "image/svg+xml" };
  }

  private toSvg(cart: Cart): string {
    const pad = 24;
    const rowH = 28;
    const headerH = 92;
    const footerH = 120;
    const width = 560;
    const rows = cart.lineItems.length;
    const height = headerH + rows * rowH + footerH;

    const itemRows = cart.lineItems
      .map((li, i) => {
        const y = headerH + i * rowH + 20;
        const name = escapeXml(`${li.quantity}× ${li.name}`);
        const line = formatUsdc((li.unitPrice * BigInt(li.quantity)) as typeof li.unitPrice);
        return (
          `<text x="${pad}" y="${y}" class="item">${name}</text>` +
          `<text x="${width - pad}" y="${y}" class="item num" text-anchor="end">${line}</text>`
        );
      })
      .join("\n");

    const totalsY = headerH + rows * rowH + 24;
    const line = (label: string, amount: string, y: number, cls = "sub") =>
      `<text x="${pad}" y="${y}" class="${cls}">${label}</text>` +
      `<text x="${width - pad}" y="${y}" class="${cls} num" text-anchor="end">${amount}</text>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .bg { fill: #ffffff; }
    .card { fill: #ffffff; stroke: #e5e7eb; stroke-width: 1; }
    .brand { fill: #111827; font: 600 20px -apple-system, Segoe UI, Roboto, sans-serif; }
    .store { fill: #6b7280; font: 400 13px -apple-system, Segoe UI, Roboto, sans-serif; }
    .item { fill: #111827; font: 400 15px -apple-system, Segoe UI, Roboto, sans-serif; }
    .sub { fill: #6b7280; font: 400 14px -apple-system, Segoe UI, Roboto, sans-serif; }
    .total { fill: #111827; font: 700 20px -apple-system, Segoe UI, Roboto, sans-serif; }
    .num { font-variant-numeric: tabular-nums; }
  </style>
  <rect class="bg" x="0" y="0" width="${width}" height="${height}" rx="16" />
  <rect class="card" x="8" y="8" width="${width - 16}" height="${height - 16}" rx="12" />
  <text x="${pad}" y="46" class="brand">Checkout preview</text>
  <text x="${pad}" y="68" class="store">${escapeXml(cart.store)} · react with 👍 to approve</text>
  <line x1="${pad}" y1="${headerH - 8}" x2="${width - pad}" y2="${headerH - 8}" stroke="#f3f4f6" />
${itemRows}
  <line x1="${pad}" y1="${totalsY - 18}" x2="${width - pad}" y2="${totalsY - 18}" stroke="#f3f4f6" />
  ${line("Subtotal", formatUsdc(cart.subtotal), totalsY)}
  ${line("Tax", formatUsdc(cart.tax), totalsY + 22)}
  ${line("Shipping", formatUsdc(cart.shipping), totalsY + 44)}
  <text x="${pad}" y="${totalsY + 80}" class="total">Total</text>
  <text x="${width - pad}" y="${totalsY + 80}" class="total num" text-anchor="end">${formatUsdc(cart.total)}</text>
</svg>`;
  }
}
