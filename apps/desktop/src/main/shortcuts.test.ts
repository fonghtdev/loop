import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type { ShortcutAction } from "../shared/shortcut";
import { createShortcuts } from "./shortcuts";

function setup(taken: string[] = []) {
  const live = new Map<string, () => void>();
  const globalShortcut = {
    register: vi.fn((a: string, cb: () => void) => (taken.includes(a) ? false : (live.set(a, cb), true))),
    unregister: vi.fn((a: string) => void live.delete(a)),
  };
  const pressed: ShortcutAction[] = [];
  const shortcuts = createShortcuts({ globalShortcut, onPress: (a) => pressed.push(a) });
  return { shortcuts, live, pressed, globalShortcut };
}
const keys = (micShortcut: string, deafenShortcut: string) => ({ micShortcut, deafenShortcut });

describe("global shortcuts", () => {
  it("registers the defaults and a press reports the right action", () => {
    const s = setup();
    s.shortcuts.apply(DEFAULT_SETTINGS);
    expect([...s.live.keys()].sort()).toEqual(["CommandOrControl+Shift+D", "CommandOrControl+Shift+M"]);
    s.live.get("CommandOrControl+Shift+M")!();
    s.live.get("CommandOrControl+Shift+D")!();
    expect(s.pressed).toEqual(["mic", "deafen"]);
    expect(s.shortcuts.failed()).toEqual([]);
  });

  it("changing a key drops the old one and registers the new one", () => {
    const s = setup();
    s.shortcuts.apply(DEFAULT_SETTINGS);
    s.shortcuts.apply(keys("Control+Alt+M", DEFAULT_SETTINGS.deafenShortcut));
    expect([...s.live.keys()].sort()).toEqual(["Control+Alt+M", "CommandOrControl+Shift+D"].sort());
    s.live.get("Control+Alt+M")!();
    expect(s.pressed).toEqual(["mic"]);
  });

  it("a key the OS refuses is reported and not kept registered; the other still works", () => {
    const s = setup(["CommandOrControl+Shift+M"]);
    s.shortcuts.apply(DEFAULT_SETTINGS);
    expect(s.shortcuts.failed()).toEqual(["mic"]);
    expect([...s.live.keys()]).toEqual(["CommandOrControl+Shift+D"]);
    s.shortcuts.apply(keys("Control+Alt+M", DEFAULT_SETTINGS.deafenShortcut)); // fixed: the failure is forgotten
    expect(s.shortcuts.failed()).toEqual([]);
  });

  it("an empty key unregisters it and registers nothing", () => {
    const s = setup();
    s.shortcuts.apply(DEFAULT_SETTINGS);
    s.shortcuts.apply(keys("", DEFAULT_SETTINGS.deafenShortcut));
    expect([...s.live.keys()]).toEqual(["CommandOrControl+Shift+D"]);
    expect(s.shortcuts.failed()).toEqual([]);
  });

  it("dispose (quit) unregisters everything", () => {
    const s = setup();
    s.shortcuts.apply(DEFAULT_SETTINGS);
    s.shortcuts.dispose();
    expect(s.live.size).toBe(0);
  });

  it("an accelerator that makes register throw counts as refused", () => {
    const s = setup();
    s.globalShortcut.register.mockImplementationOnce(() => {
      throw new Error("bad accelerator");
    });
    s.shortcuts.apply(DEFAULT_SETTINGS);
    expect(s.shortcuts.failed()).toEqual(["mic"]);
  });
});
