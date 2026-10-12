import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChannelCategory } from "./ChannelCategory";
import { QuickSwitchField } from "./QuickSwitchField";
import { toggleQuickSwitch } from "../lib/quick-switch-state";

const html = (onAdd?: () => void) =>
  renderToStaticMarkup(createElement("ul", null, createElement(ChannelCategory, { label: "Kênh văn bản", addLabel: "Tạo kênh văn bản", onAdd })));

describe("channel category header", () => {
  it("shows its label, and the + button only when adding is allowed", () => {
    expect(html()).toContain("Kênh văn bản");
    expect(html()).not.toContain("<button");
    const withAdd = html(() => {});
    expect(withAdd).toContain('aria-label="Tạo kênh văn bản"');
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
  it("offers + only with MANAGE_CHANNELS (the same check as the server menu entry), voice header preselects VOICE", () => {
    expect(src).toMatch(/const canManage = perms\.can\(Permission\.MANAGE_CHANNELS\)/);
    expect(src).toMatch(/onAdd=\{canManage \? \(\) => addChannel\(type\) : undefined\}/);
    expect(src).toMatch(/\["TEXT", "VOICE"\] as const/);
    expect(src).toMatch(/initialType=\{newType\}/);
  });
  it("the quick switch is the field under the header, not a second icon in it", () => {
    expect(src).toMatch(/<QuickSwitchField \/>/);
    expect(src).not.toMatch(/QuickSwitchButton/);
  });
});
