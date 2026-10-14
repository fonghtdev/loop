import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parsePatch, parseSettings } from "../shared/settings";
import { createSettingsStore } from "./settings";

describe("parseSettings (reading a stored file)", () => {
  it("fills defaults, keeps valid booleans, drops unknown keys and wrong types", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("junk")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings([true])).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ notifications: false, preview: "yes", closeToTray: 1, evil: true, __proto__: { x: 1 } })).toEqual({ ...DEFAULT_SETTINGS, notifications: false });
  });
});

describe("shortcut settings", () => {
  it("a stored odd or missing accelerator falls back to the default, an empty one (cleared) is kept", () => {
    expect(parseSettings({ micShortcut: "M", deafenShortcut: 5 })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ micShortcut: "" }).micShortcut).toBe("");
    expect(parseSettings({ micShortcut: "Control+Alt+K" }).micShortcut).toBe("Control+Alt+K");
  });
  it("a patch takes a valid accelerator or empty, and refuses anything else", () => {
    expect(parsePatch({ micShortcut: "Control+Alt+K" })).toEqual({ micShortcut: "Control+Alt+K" });
    expect(parsePatch({ deafenShortcut: "" })).toEqual({ deafenShortcut: "" });
    for (const bad of ["K", "Shift+K", true, null]) expect(parsePatch({ micShortcut: bad })).toBeNull();
    expect(parsePatch({ preview: "x" })).toBeNull();
  });
  it("the store refuses two shortcuts with the same keys and changes nothing", () => {
    const s = createSettingsStore(join(mkdtempSync(join(tmpdir(), "loop-settings-")), "settings.json"));
    expect(() => s.set({ micShortcut: DEFAULT_SETTINGS.deafenShortcut })).toThrow();
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(s.set({ micShortcut: "", deafenShortcut: "" }).micShortcut).toBe(""); // two empties are not a clash
  });
});

describe("parsePatch (a change from the renderer)", () => {
  it("takes known boolean keys and drops unknown ones", () => {
    expect(parsePatch({ preview: false })).toEqual({ preview: false });
    expect(parsePatch({ preview: false, extra: 1 })).toEqual({ preview: false });
  });
  it.each([
    ["a non-boolean value", { preview: "false" }],
    ["a number", { closeToTray: 0 }],
    ["only unknown keys", { admin: true }],
    ["empty", {}],
    ["null", null],
    ["an array", [{ preview: true }]],
  ])("refuses %s", (_n, raw) => {
    expect(parsePatch(raw)).toBeNull();
  });
});

describe("settings store", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "loop-settings-")), "settings.json");

  it("starts from defaults, persists changes atomically and reads them back", () => {
    const f = file();
    const s = createSettingsStore(f);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(s.set({ notifications: false })).toEqual({ ...DEFAULT_SETTINGS, notifications: false });
    expect(JSON.parse(readFileSync(f, "utf8")).notifications).toBe(false);
    expect(createSettingsStore(f).get().notifications).toBe(false);
  });

  it("a corrupt file means defaults; an invalid patch throws and changes nothing", () => {
    const f = file();
    writeFileSync(f, "{not json");
    const s = createSettingsStore(f);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => s.set({ preview: "no" })).toThrow();
    expect(() => s.set({ nope: true })).toThrow();
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });
});
