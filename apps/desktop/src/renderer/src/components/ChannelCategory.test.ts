import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChannelCategory } from "./ChannelCategory";
import { dragClass } from "./dragRow";
import { QuickSwitchField } from "./QuickSwitchField";
import { toggleQuickSwitch } from "../lib/quick-switch-state";

const html = (props: { collapsed?: boolean; onAdd?: () => void } = {}) =>
  renderToStaticMarkup(
    createElement("ul", null, createElement(ChannelCategory, { name: "Trò chuyện", collapsed: false, onToggle: () => {}, addLabel: "Tạo kênh trong Trò chuyện", ...props })),
  );

describe("channel category header", () => {
  it("its title is the fold button: aria-expanded follows the state, the chevron turns when folded", () => {
    const open = html();
    expect(open).toContain("Trò chuyện");
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain("-rotate-90");
    const folded = html({ collapsed: true });
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain("-rotate-90");
  });
  it("shows the + button only when adding is allowed", () => {
    expect(html()).not.toContain("Tạo kênh trong");
    expect(html({ onAdd: () => {} })).toContain('aria-label="Tạo kênh trong Trò chuyện"');
  });
});

describe("drag and drop is for managers only", () => {
  it("a header without drag props is not draggable and has no grab cursor; with them it is", () => {
    const plain = html();
    expect(plain).not.toContain("draggable");
    expect(plain).not.toContain("cursor-grab");
    const managed = renderToStaticMarkup(
      createElement("ul", null, createElement(ChannelCategory, { name: "X", collapsed: true, onToggle: () => {}, addLabel: "a", dnd: { draggable: true }, drop: "inside" })),
    );
    expect(managed).toContain('draggable="true"');
    expect(managed).toContain("cursor-grab");
    expect(managed).toContain('data-drop="inside"'); // a collapsed header is a drop target too
    expect(managed).toContain("ring-moss-400");
  });
  it("the indicator classes: a line before/after, a ring inside, dimmed while dragged, grab only when draggable", () => {
    expect(dragClass(false)).toBe("");
    expect(dragClass(true)).toContain("cursor-grab");
    expect(dragClass(false, "before")).toContain("inset_0_2px_0");
    expect(dragClass(false, "after")).toContain("inset_0_-2px_0");
    expect(dragClass(false, "inside")).toContain("ring-2");
    expect(dragClass(false, undefined, true)).toContain("opacity-50");
    expect(dragClass(true, "before", true)).not.toContain("animate");
  });
  it("the column wires drag props only through canManage, and only reacts to layout drags", () => {
    const src = readFileSync(join(__dirname, "ChannelColumn.tsx"), "utf8");
    expect(src).toMatch(/const dnd = [\s\S]*?\n\s+canManage\s*\?/);
    expect(src).toMatch(/const hover = [^\n]*\n\s+if \(!isLayoutDrag\(e\.dataTransfer\)\) return;/);
    expect(src).toMatch(/const release = [^\n]*\n\s+if \(!isLayoutDrag\(e\.dataTransfer\)\) return;/);
    expect(src).toMatch(/if \(layoutInFlight\(guildId\)\) return e\.preventDefault\(\)/);
    expect(src).toMatch(/saveLayout\(next, true\)/);
    expect(src).not.toMatch(/aria-grabbed/);
  });
});

describe("quick switch field", () => {
  const field = (platform: string) => {
    vi.stubGlobal("window", { loop: { platform } });
    return QuickSwitchField();
  };
  it("is a button that toggles the existing quick switcher, with the platform's shortcut shown", () => {
    const tooltip = field("win32");
    const button = tooltip.props.children;
    expect(button.props.onClick).toBe(toggleQuickSwitch);
    expect(renderToStaticMarkup(tooltip)).toMatch(/Chuyển nhanh.*Ctrl K/);
    expect(renderToStaticMarkup(field("darwin"))).toContain("⌘K");
  });
});

describe("channel column wiring", () => {
  const src = readFileSync(join(__dirname, "ChannelColumn.tsx"), "utf8");
  it("offers + and the category menu only with MANAGE_CHANNELS (the same check as the server menu entries)", () => {
    expect(src).toMatch(/const canManage = perms\.can\(Permission\.MANAGE_CHANNELS\)/);
    expect(src).toMatch(/onAdd=\{canManage \? \(\) => addChannel\(category\) : undefined\}/);
    expect(src).toMatch(/canManage && \(\s*<RowMenu id=\{`cat-/);
    expect(src).toMatch(/\{canManage && <MenuItem [^\n]*guildMenu\.createCategory/);
    expect(src).toMatch(/category=\{newIn\}/);
  });
  it("renders the tree (loose channels first, then each category) and folds through the per-account store", () => {
    expect(src).toMatch(/tree\.loose\.map[\s\S]*tree\.groups\.map/);
    expect(src).toMatch(/shownChannels\(channels, folded, keep\)/);
    expect(src).toMatch(/onToggle=\{\(\) => collapse\.toggle\(category\.id\)\}/);
  });
  it("every reorder and move goes through the one layout payload", () => {
    expect(src.match(/saveLayout\(/g)!.length).toBeGreaterThanOrEqual(5);
    expect(src).toMatch(/admin\.setLayout\(guildId, layout\)[\s\S]*send\(layoutOf\(next\)\)/);
  });
  it("the quick switch is the field under the header, not a second icon in it", () => {
    expect(src).toMatch(/<QuickSwitchField \/>/);
    expect(src).not.toMatch(/QuickSwitchButton/);
  });
});
