import { describe, expect, it } from "vitest";
import { isComposingKey, isToggleShortcut, listAction, shouldToggle } from "./quick-switch-keys";

const k = (key: string, extra: object = {}) => ({ key, ...extra });
const move = (to: number) => ({ type: "move", to });

describe("shortcut", () => {
  it("Ctrl+K and Cmd+K, either case; not held, not with Shift/Alt, not plain k", () => {
    expect(isToggleShortcut(k("k", { ctrlKey: true }))).toBe(true);
    expect(isToggleShortcut(k("K", { metaKey: true }))).toBe(true);
    expect(isToggleShortcut(k("k", { ctrlKey: true, repeat: true }))).toBe(false);
    expect(isToggleShortcut(k("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isToggleShortcut(k("k", { metaKey: true, altKey: true }))).toBe(false);
    expect(isToggleShortcut(k("k"))).toBe(false);
    expect(isToggleShortcut(k("j", { ctrlKey: true }))).toBe(false);
  });
  it("opens only when no other dialog is open; always closes", () => {
    expect(shouldToggle(false, false)).toBe(true);
    expect(shouldToggle(false, true)).toBe(false);
    expect(shouldToggle(true, true)).toBe(true);
  });
});

describe("list keys", () => {
  it("arrows wrap, Ctrl+N/P too", () => {
    expect(listAction(k("ArrowDown"), 2, 3)).toEqual(move(0));
    expect(listAction(k("ArrowUp"), 0, 3)).toEqual(move(2));
    expect(listAction(k("ArrowDown"), 0, 3)).toEqual(move(1));
    expect(listAction(k("n", { ctrlKey: true }), 0, 3)).toEqual(move(1));
    expect(listAction(k("p", { ctrlKey: true }), 0, 3)).toEqual(move(2));
  });
  it("Home/End jump, PageUp/PageDown step by 8 and stop at the ends", () => {
    expect(listAction(k("Home"), 5, 20)).toEqual(move(0));
    expect(listAction(k("End"), 5, 20)).toEqual(move(19));
    expect(listAction(k("PageDown"), 5, 20)).toEqual(move(13));
    expect(listAction(k("PageDown"), 15, 20)).toEqual(move(19));
    expect(listAction(k("PageUp"), 3, 20)).toEqual(move(0));
  });
  it("Enter opens; letters and an empty list do nothing", () => {
    expect(listAction(k("Enter"), 1, 3)).toEqual({ type: "open" });
    expect(listAction(k("a"), 1, 3)).toBeNull();
    expect(listAction(k("Enter"), 0, 0)).toBeNull();
    expect(listAction(k("ArrowDown"), 0, 0)).toBeNull();
  });
  it("IME composition (isComposing or keyCode 229) never navigates or opens", () => {
    for (const key of ["Enter", "ArrowDown", "ArrowUp", "Home", "PageDown"]) {
      expect(listAction(k(key, { isComposing: true }), 0, 5), key).toBeNull();
      expect(listAction(k(key, { keyCode: 229 }), 0, 5), key).toBeNull();
    }
    expect(isComposingKey(k("a", { keyCode: 229 }))).toBe(true);
    expect(isComposingKey(k("a"))).toBe(false);
  });
});
