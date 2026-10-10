import { describe, expect, it, vi } from "vitest";
import { MAX_BADGE } from "../shared/notify";
import { loginItemSettings, normalizeBadge, revealWindow, shouldHideOnClose, startsHidden, trayClickAction, trayMenuModel, windowIsFocused } from "./policy";

describe("badge count", () => {
  it("accepts whole numbers from 0 (clears) to the cap", () => {
    expect(normalizeBadge(0)).toBe(0);
    expect(normalizeBadge(7)).toBe(7);
    expect(normalizeBadge(MAX_BADGE)).toBe(MAX_BADGE);
  });
  it.each([-1, 1.5, MAX_BADGE + 1, NaN, Infinity, "3", null, undefined, {}, [1]])("refuses %s", (v) => {
    expect(normalizeBadge(v)).toBeNull();
  });
});

describe("close to tray", () => {
  it("hides when the setting is on", () => {
    expect(shouldHideOnClose({ closeToTray: true, quitting: false })).toBe(true);
    expect(shouldHideOnClose({ closeToTray: false, quitting: false })).toBe(false);
  });
  it("a real quit always closes, whatever the setting (the user is never trapped)", () => {
    expect(shouldHideOnClose({ closeToTray: true, quitting: true })).toBe(false);
  });
});

describe("login item", () => {
  it("registers only in the installed app, with --hidden", () => {
    expect(loginItemSettings({ isPackaged: true, startAtLogin: true })).toEqual({ openAtLogin: true, args: ["--hidden"] });
    expect(loginItemSettings({ isPackaged: true, startAtLogin: false })).toEqual({ openAtLogin: false, args: ["--hidden"] });
  });
  it("never touches the login items of a development run", () => {
    expect(loginItemSettings({ isPackaged: false, startAtLogin: true })).toBeNull();
    expect(loginItemSettings({ isPackaged: false, startAtLogin: false })).toBeNull();
  });
  it("starts hidden for --hidden or a login launch only", () => {
    expect(startsHidden({ argv: ["app", "--hidden"], wasOpenedAtLogin: false })).toBe(true);
    expect(startsHidden({ argv: ["app"], wasOpenedAtLogin: true })).toBe(true);
    expect(startsHidden({ argv: ["app"], wasOpenedAtLogin: false })).toBe(false);
  });
});

describe("tray", () => {
  it("menu model: open, notifications toggle (reflects the setting), quit", () => {
    expect(trayMenuModel({ notifications: true })).toEqual([
      { id: "open", label: "Mở Loop" },
      { id: "notifications", label: "Thông báo", checked: true },
      { id: "separator" },
      { id: "quit", label: "Thoát" },
    ]);
    expect(trayMenuModel({ notifications: false }).find((i) => i.id === "notifications")).toMatchObject({ checked: false });
  });
  it("click toggles: hide only a window that is visible and focused", () => {
    expect(trayClickAction({ visible: true, focused: true })).toBe("hide");
    expect(trayClickAction({ visible: true, focused: false })).toBe("show");
    expect(trayClickAction({ visible: false, focused: false })).toBe("show");
  });
});

describe("single instance / reveal", () => {
  it("shows and focuses; restores a minimized window first", () => {
    const calls: string[] = [];
    const w = (min: boolean) => ({ isMinimized: () => min, restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus") });
    revealWindow(w(false));
    expect(calls).toEqual(["show", "focus"]);
    calls.length = 0;
    revealWindow(w(true));
    expect(calls).toEqual(["restore", "show", "focus"]);
  });
});

describe("windowIsFocused", () => {
  const win = (focused: boolean, visible: boolean, minimized: boolean) => ({ isFocused: () => focused, isVisible: () => visible, isMinimized: () => minimized });
  it("focused means focused, on screen and not minimized", () => {
    expect(windowIsFocused(win(true, true, false), null)).toBe(true);
    expect(windowIsFocused(win(true, false, false), null)).toBe(false);
    expect(windowIsFocused(win(true, true, true), null)).toBe(false);
    expect(windowIsFocused(win(false, true, false), null)).toBe(false);
  });
  it("a test override wins either way", () => {
    expect(windowIsFocused(win(false, false, false), true)).toBe(true);
    expect(windowIsFocused(win(true, true, false), false)).toBe(false);
    const never = vi.fn();
    expect(windowIsFocused({ isFocused: never, isVisible: never, isMinimized: never }, true)).toBe(true);
    expect(never).not.toHaveBeenCalled();
  });
});
