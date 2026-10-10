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
