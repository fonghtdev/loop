import { describe, expect, it } from "vitest";
import { isEmoji } from "./emoji.js";

describe("isEmoji", () => {
  it.each(["👍", "❤️", "👍🏽", "👨‍👩‍👧‍👦", "1️⃣", "#️⃣", "🇻🇳", "🏴󠁧󠁢󠁥󠁮󠁧󠁿"])("accepts %s", (e) => expect(isEmoji(e)).toBe(true));
  it.each(["", "a", "1", "ab", "👍👍", "👍a", "a👍", "<b>", " 👍", "👍́x", "‍", "🇻", "👨‍".repeat(20), "x".repeat(40)])("rejects %j", (e) =>
    expect(isEmoji(e)).toBe(false),
  );
});
