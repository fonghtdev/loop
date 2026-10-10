import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Token values straight from styles.css, so the test checks what ships.
const css = readFileSync(join(__dirname, "styles.css"), "utf8");
const tokens = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background] pairs the UI actually uses.
const text: [string, string][] = [
  ...["surface-0", "surface-1", "surface-2", "surface-3", "surface-4"].map((bg): [string, string] => ["ink", bg]),
  ...["surface-0", "surface-1", "surface-2", "surface-3", "surface-4"].map((bg): [string, string] => ["ink-muted", bg]),
  ...["surface-0", "surface-1", "surface-2", "surface-3"].map((bg): [string, string] => ["ink-faint", bg]),
  ...["surface-1", "surface-2", "surface-3"].map((bg): [string, string] => ["moss-300", bg]), // links, accents
  ["on-moss", "moss-400"], // primary button
  ["on-moss", "moss-300"], // primary button hover
  ["on-moss", "moss-500"], // primary button pressed
  ["moss-200", "moss-900"], // avatar initial
  ["danger", "surface-2"], // field errors
  ["danger", "danger-bg"],
  ["ink", "danger-bg"],
  ["warning", "warning-bg"],
  ["ink", "warning-bg"],
  ...[1, 2, 3, 4, 5, 6].map((n): [string, string] => ["ink", `avatar-${n}`]), // avatar initials
  ["on-moss", "danger"], // destructive confirm buttons (leave, delete)
  ["danger", "surface-3"], // delete action in the message toolbar / menu
];
// Non-text UI (WCAG 1.4.11, 3:1): input boundaries, the focus ring, the primary button's shape.
const ui: [string, string][] = [
  ["line-strong", "surface-2"],
  ["line-strong", "surface-3"],
  ...["surface-0", "surface-1", "surface-2", "surface-3"].map((bg): [string, string] => ["moss-300", bg]),
  ["moss-400", "surface-2"],
  ["warning", "surface-1"], // owner crown in the member list
  ["moss-300", "surface-4"], // focus ring on the active channel
];

describe("design tokens meet WCAG AA", () => {
  it("parses the tokens", () => {
    expect(Object.keys(tokens).length).toBeGreaterThan(15);
  });
  it.each(text)("text %s on %s >= 4.5:1", (fg, bg) => {
    expect(tokens[fg], fg).toBeDefined();
    expect(tokens[bg], bg).toBeDefined();
    expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(ui)("ui %s on %s >= 3:1", (fg, bg) => {
    expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(3);
  });
  it("the formula matches known values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
