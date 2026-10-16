import { describe, expect, it } from "vitest";
import { createAutoModRuleSchema, foldText, matchesKeywords, updateAutoModRuleSchema } from "./automod.js";

describe("matchesKeywords", () => {
  it.each([
    ["accents and case on both sides", "ĐỒ NGỐC thật", ["đồ ngốc"], true],
    ["accent-free keyword, accented text", "đồ ngốc", ["do ngoc"], true],
    ["adjacent punctuation", "you ass!", ["ass"], true],
    ["start and end of text", "ass", ["ass"], true],
    ["inside a longer word", "a first class seat", ["ass"], false],
    ["a word with an accent after it is another word", "assé", ["ass"], false],
    ["digits are part of a word", "ass1 ass2", ["ass"], false],
    ["underscore separates", "bad_word", ["bad word"], true],
    ["phrase across punctuation and spaces", "so Bad,   WORD here", ["bad word"], true],
    ["phrase words not in a row", "bad other word", ["bad word"], false],
    ["phrase cut at the end", "a bad", ["bad word"], false],
    ["emoji separates words", "spam🔥spam", ["spam"], true],
    ["other scripts", "Привет МИР", ["мир"], true],
    ["no keywords", "anything", [], false],
    ["empty text", "", ["x"], false],
    ["Vietnamese tone marks only", "hoà", ["hoa"], true],
    ["the keyword's own punctuation does not matter", "free money", ["free-money!"], true],
  ])("%s", (_, text, keywords, expected) => {
    expect(matchesKeywords(text, keywords)).toBe(expected);
  });

  it("finishes fast on adversarial input (2000 characters x 500 keywords of 50 characters)", () => {
    const keywords = Array.from({ length: 500 }, (_, i) => `${"a ".repeat(24)}${i}`.trim()); // all start with "a"
    const text = "a ".repeat(1000);
    const words = Array.from({ length: 500 }, (_, i) => "a".repeat(49) + String.fromCharCode(98 + (i % 20)));
    const t0 = performance.now();
    expect(matchesKeywords(text, keywords)).toBe(false);
    expect(matchesKeywords("a".repeat(2000), words)).toBe(false);
    expect(matchesKeywords("(".repeat(2000), ["((((", ".*", "a+"])).toBe(false); // regex syntax is plain text
    expect(performance.now() - t0).toBeLessThan(500); // a few ms in practice; wide for CI
  });

  it("folds like the search index: lowercase, no accents, đ -> d, same length", () => {
    expect(foldText("Đà Nẵng ĂÂÊÔƠƯ")).toBe("da nang aaeoou");
  });
});

describe("rule schemas", () => {
  const ok = (keywords: string[]) => createAutoModRuleSchema.safeParse({ name: "r", keywords }).success;

  it("trims, drops exact repeats and defaults to enabled", () => {
    expect(createAutoModRuleSchema.parse({ name: " r ", keywords: [" x ", "x", "y"] })).toEqual({ name: "r", enabled: true, keywords: ["x", "y"] });
  });

  it("refuses bad keywords and lists", () => {
    expect(ok([])).toBe(false);
    expect(ok(["   "])).toBe(false);
    expect(ok(["!!!"])).toBe(false); // could never match
    expect(ok(["a\u0000b"])).toBe(false);
    expect(ok(["a\nb"])).toBe(false);
    expect(ok(["x".repeat(51)])).toBe(false);
    expect(ok(["x".repeat(50)])).toBe(true);
    expect(ok(Array.from({ length: 101 }, (_, i) => `k${i}`))).toBe(false);
    expect(ok(Array.from({ length: 100 }, (_, i) => `k${i}`))).toBe(true);
    expect(createAutoModRuleSchema.safeParse({ name: "x".repeat(61), keywords: ["a"] }).success).toBe(false);
    expect(createAutoModRuleSchema.safeParse({ name: "r", keywords: ["a"], extra: 1 }).success).toBe(false);
  });

  it("an update needs at least one key", () => {
    expect(updateAutoModRuleSchema.safeParse({}).success).toBe(false);
    expect(updateAutoModRuleSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});
