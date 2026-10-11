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

// Gradients straight from `--background-image-*`: every hex stop, and the radial light (rgb(.. / a)) added on top of the
// lightest stop, which is the worst case for text sitting anywhere on the surface.
const stops = (name: string) => {
  const value = css.match(new RegExp(`--background-image-${name}:\\s*([^;]+);`))![1];
  const hexes = [...value.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
  const light = value.match(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/);
  const lit = (hex: string) => (light ? composite([+light[1], +light[2], +light[3]], +light[4], rgb(hex)) : rgb(hex));
  return hexes.map(lit);
};
const surfaceGradients = ["rail", "chan", "head", "raise"];
const lightest = (name: string) => stops(name).sort((a, b) => luminance(b) - luminance(a))[0];

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
  // redesign R1: the lighter surface-5 (hover on surface-4) and the disabled primary button
  ["ink", "surface-5"],
  ["ink-muted", "surface-5"],
  ["ink-faint", "surface-4"], // disabled button label, hint text on a hovered row
  ["cosmic-200", "cosmic-900"], // "Đề xuất mới" tag, search match
  ["cosmic-300", "cosmic-900"],
  ["cosmic-200", "surface-1"],
  ["cosmic-300", "surface-1"], // selected channel row text
  ["cosmic-300", "surface-2"],
  ["cosmic-300", "surface-3"],
  ["presence-on", "surface-1"], // presence has a text label too, but the dot colour is held to AA anyway
  ["presence-idle", "surface-1"],
  ["presence-dnd", "surface-1"],
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
  // redesign R1: focus ring (cosmic-300, 2 px outline) against every surface it can sit on, 3:1
  ...["surface-0", "surface-1", "surface-2", "surface-3", "surface-4", "surface-5"].map((bg): [string, string] => ["cosmic-300", bg]),
  // presence dots on every surface an avatar sits on
  ...["presence-on", "presence-idle", "presence-dnd"].flatMap((dot) => ["surface-0", "surface-1", "surface-2", "surface-3", "surface-4", "surface-5"].map((bg): [string, string] => [dot, bg])),
];

// Worst-case backdrops behind glass, from the same tokens: each aurora colour at full strength (auth card); the dialog
// dim over the lightest content, ink text (dialog panel); ink itself (popover menu, floating over the app).
const glows = ["violet", "teal", "blue"].map((g) => [`aurora-${g}`, rgb(tokens[`aurora-${g}`])] as const);
const behindAuth = glows.map(([n, c]) => [`auth card over ${n}`, c] as const);
const behindDialog = [["dialog over dimmed ink text", dimmed(rgb(tokens.ink))]] as const;
const behindPopover = [["popover over ink text", rgb(tokens.ink)]] as const;
const textOnGlass = ["ink", "ink-muted", "ink-faint", "danger", "moss-300"];
// The drop overlay (surface-2 at 92%) over the lightest thing that could be behind it: ink text.
const overlay = composite(rgb(tokens["surface-2"]), 0.92, rgb(tokens.ink));
describe("redesign R1 materials", () => {
  // every shipped gradient endpoint, with its radial light on top: the three text colours at 4.5:1
  for (const g of surfaceGradients)
    for (const tk of ["ink", "ink-muted", "ink-faint"])
      it(`text ${tk} on the lightest point of bg-${g} >= 4.5:1`, () => {
        expect(contrast(rgb(tokens[tk]), lightest(g))).toBeGreaterThanOrEqual(4.5);
      });
  it("the mock's reference number: ink-faint on the lightest raise point is 5.09", () => {
    expect(contrast(rgb(tokens["ink-faint"]), lightest("raise"))).toBeCloseTo(5.09, 1);
  });
  it("moss button: on-moss on every stop of the gradient >= 4.5:1 and the button against surface-2 >= 3:1", () => {
    for (const stop of stops("moss")) {
      expect(contrast(rgb(tokens["on-moss"]), stop)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(stop, rgb(tokens["surface-2"]))).toBeGreaterThanOrEqual(3);
    }
  });
  it("focus ring cosmic-300 against the lightest raise point >= 3:1", () => {
    expect(contrast(rgb(tokens["cosmic-300"]), lightest("raise"))).toBeGreaterThanOrEqual(3);
  });
  it("moss-300 links on the lightest raise point >= 4.5:1", () => {
    expect(contrast(rgb(tokens["moss-300"]), lightest("raise"))).toBeGreaterThanOrEqual(4.5);
  });
  it("the type scale keeps line-heights on a 4 px grid", () => {
    const pairs = [...css.matchAll(/--text-[\w]+--line-height:\s*(\d+)px/g)].map((m) => +m[1]);
    expect(pairs).toHaveLength(10);
    for (const lh of pairs) expect(lh % 4).toBe(0);
  });
  it("radii are the documented scale", () => {
    const r = Object.fromEntries([...css.matchAll(/--radius-([\w]+):\s*(\d+)px/g)].map((m) => [m[1], +m[2]]));
    expect(r).toEqual({ xs: 6, sm: 8, control: 12, card: 16, panel: 20, glass: 28 });
  });
  it("the grain is a background-image on solid surfaces (no overlay), 2% by default, and has an off switch", () => {
    expect(css).toMatch(/@utility grain\s*{\s*background-image: var\(--grain-img\), var\(--grain-under, none\);/);
    expect(css).toMatch(/html\[data-grain="off"\] \.grain\s*{\s*background-image: var\(--grain-under, none\)/);
    expect(css).toMatch(/opacity='\.02'/);
  });
  it("the reduced-motion preference reaches CSS for both the in-app choice and the OS media query", () => {
    expect(css).toMatch(/html\[data-motion="reduced"\] \*/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*html:not\(\[data-motion="full"\]\)/);
  });
});

describe("redesign R2 auth screen", () => {
  // The brand panel's text sits straight on the aurora (no glass): the static `ambient` gradient plus the drifting blob on
  // top of it. Both strengths are read from the shipped source, so changing a percentage re-runs this check.
  const authSource = readFileSync(join(__dirname, "screens/AuthScreen.tsx"), "utf8");
  const strength = (source: string, colour: string, re: (c: string) => RegExp) => +source.match(re(colour))![1] / 100;
  const behindBrand = ["violet", "teal", "blue"].map((c) => {
    const ambient = strength(css, c, (n) => new RegExp(`var\\(--color-aurora-${n}\\) (\\d+)%`));
    const blob = strength(authSource, c, (n) => new RegExp(`color-mix\\(in_srgb,var\\(--color-aurora-${n}\\)_(\\d+)%`));
    const base = rgb(tokens["surface-2"]);
    return [`aurora-${c}`, composite(rgb(tokens[`aurora-${c}`]), blob, composite(rgb(tokens[`aurora-${c}`]), ambient, base))] as const;
  });
  // tagline and lead are `ink`: ink-muted would not hold over the violet
  for (const [name, backdrop] of behindBrand)
    it(`brand text ink on ${name} (ambient + blob) >= 4.5:1`, () => {
      expect(contrast(rgb(tokens.ink), backdrop)).toBeGreaterThanOrEqual(4.5);
    });
  it("the oversized quiet logomark (moss-900) stays decorative: below text contrast on purpose, it is aria-hidden", () => {
    expect(contrast(tokens["moss-900"], tokens["surface-2"])).toBeLessThan(3);
  });
});

describe("redesign R3 chat surfaces", () => {
  const token = (name: string) => {
    const m = css.match(new RegExp(`--color-${name}:\\s*rgb\\((\\d+) (\\d+) (\\d+) / ([\\d.]+)\\)`))!;
    return { rgb: [+m[1], +m[2], +m[3]] as Rgb, alpha: +m[4] };
  };
  const wash = token("cosmic-wash");
  const white = (alpha: number, under: Rgb) => composite([255, 255, 255], alpha, under);
  // the active channel / DM row: cosmic wash, then the 5% white lift of the gradient, over the lightest point of the column
  const activeRow = white(0.05, composite(wash.rgb, wash.alpha, lightest("chan")));
  // hover lifts used on rows (channel .045, member .045, toolbar button .07, message .03)
  const hoverChan = white(0.045, lightest("chan"));
  const hoverMessage = white(0.03, rgb(tokens["surface-2"]));
  const hoverToolbar = white(0.07, lightest("raise"));

  it.each(["ink", "ink-muted"])("%s on the active channel row (wash + lift over the lightest column point) >= 4.5:1", (tk) => {
    expect(contrast(rgb(tokens[tk]), activeRow)).toBeGreaterThanOrEqual(4.5);
  });
  it("ink-muted and ink on a hovered channel / member / DM row >= 4.5:1", () => {
    expect(contrast(rgb(tokens["ink-muted"]), hoverChan)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(tokens.ink), hoverChan)).toBeGreaterThanOrEqual(4.5);
  });
  it("ink-faint timestamps and ink text on a hovered message row >= 4.5:1", () => {
    expect(contrast(rgb(tokens["ink-faint"]), hoverMessage)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(tokens.ink), hoverMessage)).toBeGreaterThanOrEqual(4.5);
  });
  it("toolbar icons on the raise surface: ink-muted and danger >= 4.5:1, also hovered", () => {
    for (const bg of [lightest("raise"), hoverToolbar]) {
      expect(contrast(rgb(tokens["ink-muted"]), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(tokens.danger), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(tokens["moss-300"]), bg)).toBeGreaterThanOrEqual(4.5); // the "copied" check
    }
  });
  it("upload progress ring (moss-300) on its scrim over the thumbnail >= 3:1", () => {
    expect(contrast(rgb(tokens["moss-300"]), composite(rgb(tokens["surface-0"]), 0.65, rgb(tokens["surface-2"])))).toBeGreaterThanOrEqual(3);
  });
  it("the account avatar's presence ring (presence-on at 60%) against the account strip >= 3:1", () => {
    const strip = rgb(tokens["surface-0"]);
    expect(contrast(composite(rgb(tokens["presence-on"]), 0.6, strip), strip)).toBeGreaterThanOrEqual(3);
  });
  it("the over-limit composer ring and the failed-upload ring (danger) against the raise surface >= 3:1", () => {
    expect(contrast(rgb(tokens.danger), lightest("raise"))).toBeGreaterThanOrEqual(3);
  });
  it("the sticky day label (ink-faint) on the solid surface-2 it sits on >= 4.5:1", () => {
    expect(contrast(tokens["ink-faint"], tokens["surface-2"])).toBeGreaterThanOrEqual(4.5);
  });
  it("density variables: comfy is the root default and compact only changes sizes", () => {
    expect(css).toMatch(/:root\s*{\s*--m-av: 40px;\s*--m-gs: 16px;\s*--m-py: 2px;\s*--m-fs: 15px;\s*--m-lh: 24px;/);
    expect(css).toMatch(/html\[data-density="compact"\]\s*{\s*--m-av: 32px;/);
  });
});

describe("redesign R4 voice, calls, friends, settings, viewer", () => {
  const white = (alpha: number, under: Rgb) => composite([255, 255, 255], alpha, under);
  const surface2 = rgb(tokens["surface-2"]);
  const worstGlass = glassOver(rgb(tokens.ink)); // glass over the lightest content behind it (toast, popover)

  it("the drop overlay: cosmic-200 title and the cosmic-300 dashed border on the overlay over the worst-case backdrop", () => {
    expect(contrast(tokens["cosmic-200"], overlay)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["cosmic-300"], overlay)).toBeGreaterThanOrEqual(3);
  });
  it("friends / settings tabs and rows: ink, ink-muted and the ink-faint count on the hovered tab (4.5% lift) >= 4.5:1", () => {
    const hover = white(0.045, surface2);
    for (const tk of ["ink", "ink-muted", "ink-faint"]) expect(contrast(rgb(tokens[tk]), hover), tk).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(tokens["ink-muted"]), white(0.04, surface2))).toBeGreaterThanOrEqual(4.5); // a hovered friend row's subtitle
  });
  it("toast: ink text and the moss-300 / danger icons on the worst-case glass (>= 4.5 text, >= 3 icons)", () => {
    expect(contrast(rgb(tokens.ink), worstGlass)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(tokens["ink-muted"]), worstGlass)).toBeGreaterThanOrEqual(4.5); // close button
    for (const tk of ["moss-300", "danger"]) expect(contrast(rgb(tokens[tk]), worstGlass), tk).toBeGreaterThanOrEqual(3);
  });
  it("segmented control: unselected ink-muted on its inset track (surface-1), selected labels on their thumbs", () => {
    expect(contrast(tokens["ink-muted"], tokens["surface-1"])).toBeGreaterThanOrEqual(4.5);
    for (const [fg, bg] of [["ink", "surface-4"], ["moss-200", "moss-900"], ["danger", "danger-bg"]]) expect(contrast(tokens[fg], tokens[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it("the danger section: danger title, ink-muted body on danger-bg at 40% over the settings surface", () => {
    const bg = composite(rgb(tokens["danger-bg"]), 0.4, surface2);
    expect(contrast(rgb(tokens.danger), bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(tokens["ink-muted"]), bg)).toBeGreaterThanOrEqual(4.5);
  });
  it("the participant name chip (surface-0 at 80%) keeps ink >= 4.5:1 even over a pure white video frame", () => {
    expect(contrast(rgb(tokens.ink), composite(rgb(tokens["surface-0"]), 0.8, [255, 255, 255]))).toBeGreaterThanOrEqual(4.5);
  });
  it("the speaking ring / ripple (cosmic-300) on the tile surface and the call dialog's glass >= 3:1", () => {
    expect(contrast(rgb(tokens["cosmic-300"]), lightest("raise"))).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb(tokens["cosmic-300"]), worstGlass)).toBeGreaterThanOrEqual(3);
  });
  it("the answer / decline buttons: on-moss on every stop of the moss gradient and on danger >= 4.5:1", () => {
    for (const stop of stops("moss")) expect(contrast(rgb(tokens["on-moss"]), stop)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["on-moss"], tokens.danger)).toBeGreaterThanOrEqual(4.5);
  });
});

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
