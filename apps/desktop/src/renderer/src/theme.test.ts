import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Token values straight from styles.css, so the test checks what ships.
const css = readFileSync(join(__dirname, "styles.css"), "utf8");
const tokens = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** WCAG contrast ratio of two opaque colours (hex strings or rgb triples). */
function contrast(a: string | Rgb, b: string | Rgb) {
  const [hi, lo] = [luminance(typeof a === "string" ? rgb(a) : a), luminance(typeof b === "string" ? rgb(b) : b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `fg` at `alpha` (0..1) painted over the opaque `bg`. */
const composite = (fg: Rgb, alpha: number, bg: Rgb): Rgb => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;

// Glass values from :root, so the test checks what ships.
const rootVar = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))![1].trim();
const percent = (name: string) => parseFloat(rootVar(name)) / 100;
const glass = { tint: rgb(rootVar("glass-tint")), alpha: percent("glass-tint-alpha"), sheen: percent("glass-sheen") };
/** The final colour of the glass panel's fill over an opaque backdrop: tint first, then the white sheen. */
const glassOver = (backdrop: Rgb): Rgb => composite([255, 255, 255], glass.sheen, composite(glass.tint, glass.alpha, backdrop));
const dim = css.match(/dialog::backdrop\s*{\s*background:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/)!;
const dimmed = (under: Rgb) => composite([+dim[1], +dim[2], +dim[3]], +dim[4], under);

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
  ["danger", "surface-4"], // the same item hovered
  ["moss-300", "surface-4"], // "Thử lại" on a broken image, hovered
  ["ink-faint", "surface-2"], // image file name under a picture
  ["danger", "surface-3"], // failed upload line in the tray
  ["danger", "surface-1"], // the local user's muted / deafened glyph in the channel column
  ["warning", "surface-1"], // microphone / camera problem note in the voice bar
  ["moss-300", "surface-1"], // voice bar status "Đã kết nối" (already above, kept explicit)
  ["ink", "surface-0"], // participant name chip over a video tile
  ["moss-200", "moss-900"], // pressed camera button, incoming-call icon
  ["danger", "danger-bg"], // pressed mute / deafen button
  ["ink-muted", "surface-1"], // voice participant names and the bar's second line
  ["warning", "surface-2"], // ADMINISTRATOR warning in the role editor (settings view, solid surface-2)
  ["moss-200", "moss-900"], // "Cho phép" selected in the overwrite editor (also above)
  ["danger", "danger-bg"], // "Từ chối" selected (also above)
  ["ink", "surface-4"], // "Mặc định" selected, active settings tab
  ["ink-muted", "surface-3"], // role chips on member rows
  ["moss-300", "surface-2"], // "Đã lưu" and permitted lines in the preview
  ["danger", "surface-4"], // Nguy hiểm tab selected
];
// Non-text UI (WCAG 1.4.11, 3:1): input boundaries, the focus ring, the primary button's shape.
const ui: [string, string][] = [
  ["line-strong", "surface-2"],
  ["line-strong", "surface-3"],
  ...["surface-0", "surface-1", "surface-2", "surface-3"].map((bg): [string, string] => ["moss-300", bg]),
  ["moss-400", "surface-2"],
  ["warning", "surface-1"], // owner crown in the member list
  ["moss-300", "surface-4"], // focus ring on the active channel
  // online dot (moss-400) on whatever the avatar sits on: channel column, friends rows, header, hovered rows
  ...["surface-1", "surface-2", "surface-3", "surface-4"].map((bg): [string, string] => ["moss-400", bg]),
  ["moss-300", "surface-2"], // drop-zone dashed border
  ["moss-300", "surface-3"], // speaking ring around a participant tile
  ["moss-300", "surface-1"], // speaking ring around a participant avatar in the channel column
  ["moss-300", "surface-4"], // the same ring on a hovered row
  ["danger", "danger-bg"], // pressed mute / deafen button icon
  ["moss-200", "moss-900"], // pressed camera icon
  ["danger", "surface-2"], // border of the delete-server panel, denied preview marks
  ["moss-300", "moss-900"], // border of the selected "Cho phép"
  ["line-strong", "surface-4"], // border of the selected "Mặc định"
  ...["surface-0", "surface-1", "surface-3", "surface-4"].map((bg): [string, string] => ["danger", bg]), // unread count bubble on the rail / DM rows (and hovered)
  ["moss-300", "surface-3"], // unread dot on a hovered channel row
  // switch (settings): on track against its panel / hovered row, off track border, knobs against their tracks
  ...["surface-1", "surface-3"].map((bg): [string, string] => ["moss-400", bg]),
  ["line-strong", "surface-1"],
  ["ink-muted", "surface-4"],
  ["on-moss", "moss-400"],
  ["danger", "danger-bg"], // border of the selected "Từ chối" (also above)
];

// Worst-case backdrops behind glass, from the same tokens: each ambient glow at full strength (auth card); the dialog
// dim over the lightest content, ink text (dialog panel); ink itself (popover menu, floating over the app).
const glows = ["violet", "teal", "blue"].map((g) => [`glow-${g}`, rgb(rootVar(`glow-${g}`))] as const);
const behindAuth = glows.map(([n, c]) => [`auth card over ${n}`, c] as const);
const behindDialog = [["dialog over dimmed ink text", dimmed(rgb(tokens.ink))]] as const;
const behindPopover = [["popover over ink text", rgb(tokens.ink)]] as const;
const textOnGlass = ["ink", "ink-muted", "ink-faint", "danger", "moss-300"];
// The drop overlay (surface-2 at 90%) over the lightest thing that could be behind it: ink text.
const overlay = composite(rgb(tokens["surface-2"]), 0.9, rgb(tokens.ink));
describe("design tokens meet WCAG AA", () => {
  it("drop-zone text (moss-300) on its overlay over the worst-case backdrop >= 4.5:1", () => {
    expect(contrast(tokens["moss-300"], overlay)).toBeGreaterThanOrEqual(4.5);
  });
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
  describe("on composited glass (worst-case backdrop)", () => {
    // ink-faint (hints) and moss-300 (links) never sit on a popover; ink and danger do
    for (const [where, backdrop] of [...behindAuth, ...behindDialog, ...behindPopover])
      for (const tk of textOnGlass.filter((tk) => !where.startsWith("popover") || ["ink", "danger"].includes(tk)))
        it(`text ${tk} on ${where} >= 4.5:1`, () => {
          expect(contrast(tokens[tk], glassOver(backdrop))).toBeGreaterThanOrEqual(4.5);
        });
    for (const [where, backdrop] of [...behindAuth, ...behindDialog])
      it(`input border line-strong on ${where} >= 3:1`, () => {
        expect(contrast(tokens["line-strong"], glassOver(backdrop))).toBeGreaterThanOrEqual(3);
      });
  });
  describe("solid fallback (no backdrop-filter, reduced transparency)", () => {
    it.each(["ink", "ink-muted", "ink-faint", "danger", "moss-300"])("%s on surface-3 >= 4.5:1", (tk) => {
      expect(contrast(tokens[tk], tokens["surface-3"])).toBeGreaterThanOrEqual(4.5);
    });
    it("the fallback block is solid with the same border, for each trigger", () => {
      const block = css.slice(css.indexOf("@utility glass"), css.indexOf("@utility ambient"));
      expect(block).toMatch(/@supports not \(backdrop-filter: blur\(1px\)\)\s*{[^}]*background: var\(--color-surface-3\);[^}]*border-color: var\(--color-line\)/);
      expect(block).toMatch(
        /@media \(prefers-reduced-transparency: reduce\), \(forced-colors: active\)\s*{[^}]*background: var\(--color-surface-3\);[^}]*border-color: var\(--color-line\);[^}]*backdrop-filter: none/,
      );
    });
  });
  it("composite() and contrast() behave", () => {
    expect(composite([255, 255, 255], 0.5, [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
    expect(composite([10, 20, 30], 1, [200, 200, 200])).toEqual([10, 20, 30]);
    expect(composite([10, 20, 30], 0, [200, 100, 50])).toEqual([200, 100, 50]);
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  });
  it("the formula matches known values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
