import { describe, expect, it } from "vitest";
import { canAddRule, draftOf, parseKeywords, ruleFormErrors, rulePatch } from "./automod";

const rule = { id: "r", guildId: "g", name: "Từ cấm", enabled: true, keywords: ["a", "b"], createdById: null, createdAt: "" };

describe("AutoMod form", () => {
  it("one keyword per line: trimmed, blanks skipped, repeats dropped", () => {
    expect(parseKeywords(" a \n\n b\na\n")).toEqual(["a", "b"]);
  });
  it("validates like the server and counts live", () => {
    expect(ruleFormErrors({ name: "r", keywords: "a\nb", enabled: true })).toMatchObject({ ok: true, count: 2 });
    expect(ruleFormErrors({ name: " ", keywords: "a", enabled: true }).name).toBeTruthy();
    expect(ruleFormErrors({ name: "x".repeat(61), keywords: "a", enabled: true }).name).toMatch(/60/);
    expect(ruleFormErrors({ name: "r", keywords: "\n \n", enabled: true }).keywords).toMatch(/ít nhất một/);
    expect(ruleFormErrors({ name: "r", keywords: Array.from({ length: 101 }, (_, i) => `k${i}`).join("\n"), enabled: true })).toMatchObject({ count: 101, ok: false });
    expect(ruleFormErrors({ name: "r", keywords: `ok\n${"x".repeat(51)}`, enabled: true }).keywords).toMatch(/50 ký tự/);
    expect(ruleFormErrors({ name: "r", keywords: "ok\n!!!", enabled: true }).keywords).toMatch(/"!!!".*chữ cái/);
  });
  it("sends only what changed; at most 5 rules", () => {
    expect(rulePatch(rule, draftOf(rule))).toBeNull();
    expect(rulePatch(rule, { ...draftOf(rule), keywords: "a\nb\nc", enabled: false })).toEqual({ keywords: ["a", "b", "c"], enabled: false });
    expect(rulePatch(rule, { ...draftOf(rule), name: " Mới " })).toEqual({ name: "Mới" });
    expect([4, 5].map(canAddRule)).toEqual([true, false]);
  });
});
