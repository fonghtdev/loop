import { isEmoji } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { EMOJI_COLUMNS, EMOJI_FLAT, EMOJI_GROUPS, moveEmojiFocus } from "./emoji-data";

describe("picker data", () => {
  it("every emoji is one the server accepts, none repeats, every group fills whole rows", () => {
    expect(EMOJI_FLAT.filter((e) => !isEmoji(e))).toEqual([]);
    expect(new Set(EMOJI_FLAT).size).toBe(EMOJI_FLAT.length);
    for (const g of EMOJI_GROUPS) expect(g.emoji.length % EMOJI_COLUMNS, g.label).toBe(0);
  });
});

describe("moveEmojiFocus", () => {
  it("moves by one or by a row and stops at the edges", () => {
    expect(moveEmojiFocus(0, "ArrowRight")).toBe(1);
    expect(moveEmojiFocus(1, "ArrowLeft")).toBe(0);
    expect(moveEmojiFocus(0, "ArrowLeft")).toBe(0);
    expect(moveEmojiFocus(3, "ArrowDown")).toBe(3 + EMOJI_COLUMNS);
    expect(moveEmojiFocus(3, "ArrowUp")).toBe(3);
    const last = EMOJI_FLAT.length - 1;
    expect(moveEmojiFocus(last, "ArrowRight")).toBe(last);
    expect(moveEmojiFocus(last, "ArrowDown")).toBe(last);
    expect(moveEmojiFocus(5, "End")).toBe(last);
    expect(moveEmojiFocus(5, "Home")).toBe(0);
    expect(moveEmojiFocus(5, "x")).toBe(5);
  });
});
