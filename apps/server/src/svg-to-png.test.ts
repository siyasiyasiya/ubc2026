import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asPng } from "./svg-to-png.js";

describe("asPng", () => {
  it("turns an SVG checkout card into a PNG and leaves other images alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "png-"));
    const svgPath = join(dir, "card.svg");
    await writeFile(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text x="10" y="40">react with 👍 to approve</text></svg>`);
    const png = await asPng({ uri: svgPath });
    expect(png).toEqual({ uri: join(dir, "card.png"), mimeType: "image/png" });
    const bytes = await readFile(png.uri);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(await asPng({ uri: "/tmp/photo.jpg" })).toEqual({ uri: "/tmp/photo.jpg" });
  });
});
