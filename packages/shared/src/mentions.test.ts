import { describe, expect, it } from "vitest";
import { hasEveryoneMention, MAX_MENTIONS_PER_MESSAGE, mentionIds } from "./mentions.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("mentionIds", () => {
  it("collects <@uuid> tokens in order, lowercased, without duplicates", () => {
    expect(mentionIds(`a <@${id(2)}> b <@${id(1)}><@${id(2)}> <@${id(1).toUpperCase()}>`)).toEqual([id(2), id(1)]);
  });
  it("ignores malformed tokens", () => {
    expect(mentionIds("<@nope> <@123> <@ 00000000-0000-4000-8000-000000000001> @00000000-0000-4000-8000-000000000001")).toEqual([]);
  });
  it("stops at the cap", () => {
    const text = Array.from({ length: MAX_MENTIONS_PER_MESSAGE + 3 }, (_, i) => `<@${id(i)}>`).join("");
    expect(mentionIds(text)).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
  });
});

describe("hasEveryoneMention", () => {
  it.each([["@everyone", true], ["hey @here!", true], ["x\n@everyone", true], ["a@everyone", false], ["@everyones", false], ["@hereby", false], ["everyone", false]])("%j -> %s", (text, expected) => {
    expect(hasEveryoneMention(text)).toBe(expected);
  });
});
