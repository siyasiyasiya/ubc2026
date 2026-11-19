import { describe, expect, it } from "vitest";
import { isPdf } from "./receipt.js";

describe("isPdf", () => {
  it("detects PDFs by mime type", () => {
    expect(isPdf({ uri: "/tmp/x", mimeType: "application/pdf" })).toBe(true);
  });

  it("detects PDFs by extension (any case), even without a mime type", () => {
    expect(isPdf({ uri: "/tmp/receipt.PDF" })).toBe(true);
    expect(isPdf({ uri: "/tmp/receipt.pdf" })).toBe(true);
  });

  it("treats images as not-PDF (they take the JPEG path)", () => {
    expect(isPdf({ uri: "/tmp/receipt.heic", mimeType: "image/heic" })).toBe(false);
    expect(isPdf({ uri: "/tmp/photo.jpg" })).toBe(false);
  });
});
