import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OG_HEIGHT, OG_WIDTH, ogPng, ogSvg, wrap } from "../src/og/card.js";

describe("OG card", () => {
  it("renders a 1200x630 PNG", () => {
    const png = ogPng({ eyebrow: "Companies using", title: "Which sites use React?", stat: "3,631,229", statLabel: "websites run React" });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  it("draws a logo tile only when there is an icon", () => {
    const icon = readFileSync("site/assets/apple-touch-icon-180.png");
    expect(ogSvg({ eyebrow: "x", title: "y" })).not.toContain("<image");
    expect(ogSvg({ eyebrow: "x", title: "y", icon })).toContain("data:image/png;base64,");
  });

  it("escapes text", () => {
    expect(ogSvg({ eyebrow: "a", title: "<b>&" })).toContain("&lt;b&gt;&amp;");
  });

  it("wraps long titles to two lines with an ellipsis", () => {
    const lines = wrap("one two three four five six seven eight nine ten eleven twelve thirteen", 64, 400, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });
});
