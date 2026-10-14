import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, formatAccelerator, isAccelerator } from "./shortcut";

describe("isAccelerator", () => {
  it.each(["CommandOrControl+Shift+M", "Control+Alt+F12", "Alt+Space", "Command+1", "Super+Up", "Control+Shift+Alt+K"])("accepts %s", (a) => expect(isAccelerator(a)).toBe(true));
  it.each([
    ["no modifier", "M"],
    ["only Shift", "Shift+M"],
    ["no key", "Control+Shift"],
    ["a modifier twice", "Control+Control+M"],
    ["a key then a modifier", "M+Control"],
    ["media key", "Control+MediaPlayPause"],
    ["F25", "Control+F25"],
    ["lowercase", "control+m"],
    ["empty", ""],
    ["not a string", 5],
    ["injection", "Control+M; rm"],
  ])("refuses %s", (_n, a) => expect(isAccelerator(a)).toBe(false));
});

describe("acceleratorFromEvent", () => {
  const ev = (code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  it("builds an accelerator from the physical key", () => {
    expect(acceleratorFromEvent(ev("KeyM", { metaKey: true, shiftKey: true }), "darwin")).toBe("Command+Shift+M");
    expect(acceleratorFromEvent(ev("Digit5", { ctrlKey: true }), "win32")).toBe("Control+5");
    expect(acceleratorFromEvent(ev("F4", { altKey: true }), "win32")).toBe("Alt+F4");
    expect(acceleratorFromEvent(ev("ArrowUp", { ctrlKey: true }), "linux")).toBe("Control+Up");
    expect(acceleratorFromEvent(ev("KeyM", { metaKey: true }), "win32")).toBe("Super+M");
  });
  it("waits while only a modifier, a lone key or an odd key is down", () => {
    expect(acceleratorFromEvent(ev("ControlLeft", { ctrlKey: true }), "win32")).toBeNull();
    expect(acceleratorFromEvent(ev("KeyM"), "win32")).toBeNull();
    expect(acceleratorFromEvent(ev("KeyM", { shiftKey: true }), "win32")).toBeNull();
    expect(acceleratorFromEvent(ev("Comma", { ctrlKey: true }), "win32")).toBeNull();
  });
});

describe("formatAccelerator", () => {
  it("uses symbols on macOS and names elsewhere", () => {
    expect(formatAccelerator("CommandOrControl+Shift+M", "darwin")).toBe("⌘⇧M");
    expect(formatAccelerator("CommandOrControl+Shift+M", "win32")).toBe("Ctrl+Shift+M");
    expect(formatAccelerator("Super+Alt+K", "win32")).toBe("Win+Alt+K");
  });
});
