import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, formatAccelerator, isAccelerator, lacksRealModifier } from "./shortcut";

describe("isAccelerator", () => {
  it.each(["CommandOrControl+Shift+M", "Control+Alt+F12", "Alt+Space", "Command+1", "Super+Up", "Control+Shift+Alt+K", "Control+=", "=", "F9", "F24", "Shift+;", "Control+\\", "Alt+`", "Control+[", "num0", "Control+numadd", "Home", "Control+PageDown"])("accepts %s", (a) => expect(isAccelerator(a)).toBe(true));
  it.each([
    ["no key", "Control+Shift"],
    ["a modifier twice", "Control+Control+M"],
    ["a key then a modifier", "M+Control"],
    ["Escape (clears)", "Escape"],
    ["Backspace (clears)", "Control+Backspace"],
    ["Plus (Electron throws)", "Control++"],
    ["raw plus", "+"],
    ["two keys", "Control+M+N"],
    ["trailing plus", "Control+"],
    ["overlong", `${"Control+".repeat(50)}M`],
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
  it.each([
    ["Equal", "=", "Control+="],
    ["Minus", "-", "Control+-"],
    ["BracketLeft", "[", "Control+["],
    ["BracketRight", "]", "Control+]"],
    ["Semicolon", ";", "Control+;"],
    ["Quote", "'", "Control+'"],
    ["Comma", ",", "Control+,"],
    ["Period", ".", "Control+."],
    ["Slash", "/", "Control+/"],
    ["Backslash", "\\", "Control+\\"],
    ["Backquote", "`", "Control+`"],
    ["Numpad3", "3", "Control+num3"],
    ["NumpadAdd", "+", "Control+numadd"],
    ["NumpadSubtract", "-", "Control+numsub"],
    ["NumpadMultiply", "*", "Control+nummult"],
    ["NumpadDivide", "/", "Control+numdiv"],
    ["NumpadDecimal", ".", "Control+numdec"],
    ["F24", "F24", "Control+F24"],
    ["PageDown", "PageDown", "Control+PageDown"],
    ["Delete", "Delete", "Control+Delete"],
    ["Space", " ", "Control+Space"],
  ])("maps %s (key %j) to %s", (code, key, expected) => {
    expect(acceleratorFromEvent({ ...ev(code, { ctrlKey: true }), key } as never, "win32")).toBe(expected);
  });
  it("binds a lone key with no modifier", () => {
    expect(acceleratorFromEvent(ev("Equal"), "win32")).toBe("=");
    expect(acceleratorFromEvent(ev("F9"), "darwin")).toBe("F9");
    expect(acceleratorFromEvent(ev("KeyM"), "win32")).toBe("M");
    expect(acceleratorFromEvent(ev("Space"), "win32")).toBe("Space");
  });
  it("follows the physical key, not the character, whatever the layout or Shift", () => {
    // US + Shift: key "+" ; German: the same physical key types "+" and the next one types "#"
    expect(acceleratorFromEvent({ ...ev("Equal", { shiftKey: true }), key: "+" } as never, "win32")).toBe("Shift+=");
    expect(acceleratorFromEvent({ ...ev("Backslash", { ctrlKey: true }), key: "#" } as never, "win32")).toBe("Control+\\");
    expect(acceleratorFromEvent({ ...ev("KeyQ", { ctrlKey: true }), key: "a" } as never, "win32")).toBe("Control+Q"); // AZERTY
  });
  it("waits on a modifier alone and refuses keys that clear or are not bindable", () => {
    expect(acceleratorFromEvent(ev("ControlLeft", { ctrlKey: true }), "win32")).toBeNull();
    expect(acceleratorFromEvent(ev("ShiftLeft", { shiftKey: true }), "win32")).toBeNull();
    expect(acceleratorFromEvent(ev("MetaLeft", { metaKey: true }), "darwin")).toBeNull();
    for (const code of ["Escape", "Backspace", "Tab", "CapsLock", "IntlBackslash", "MediaPlayPause", "AudioVolumeUp"]) expect(acceleratorFromEvent(ev(code, { ctrlKey: true }), "win32")).toBeNull();
  });
});

describe("lacksRealModifier", () => {
  it.each(["=", "F9", "Shift+=", "Shift+M", "num0"])("%s has none", (a) => expect(lacksRealModifier(a)).toBe(true));
  it.each(["Control+=", "CommandOrControl+Shift+M", "Alt+F9", "Super+Space", "Shift+Command+;"])("%s has one", (a) => expect(lacksRealModifier(a)).toBe(false));
});

describe("formatAccelerator", () => {
  it("uses symbols on macOS and names elsewhere", () => {
    expect(formatAccelerator("CommandOrControl+Shift+M", "darwin")).toBe("⌘⇧M");
    expect(formatAccelerator("CommandOrControl+Shift+M", "win32")).toBe("Ctrl+Shift+M");
    expect(formatAccelerator("Super+Alt+K", "win32")).toBe("Win+Alt+K");
  });
  it("shows punctuation, lone keys and the keypad", () => {
    expect(formatAccelerator("Control+=", "win32")).toBe("Ctrl+=");
    expect(formatAccelerator("Control+=", "darwin")).toBe("⌃=");
    expect(formatAccelerator("F9", "win32")).toBe("F9");
    expect(formatAccelerator("Command+Shift+[", "darwin")).toBe("⌘⇧[");
    expect(formatAccelerator("Control+num4", "win32")).toBe("Ctrl+Num 4");
    expect(formatAccelerator("Alt+numadd", "darwin")).toBe("⌥Num +");
  });
});
