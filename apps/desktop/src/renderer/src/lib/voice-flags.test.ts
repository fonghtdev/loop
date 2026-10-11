import { describe, expect, it } from "vitest";
import { encodeDeafened, indicatorsOf, META_MAX, parseDeafened } from "./voice-flags";

describe("indicatorsOf", () => {
  it.each([
    ["nothing known", {}, []],
    ["all fine", { micOff: false, deafened: false }, []],
    ["muted", { micOff: true }, ["mic"]],
    ["deafened shows both, even when the mic flag is not set", { deafened: true }, ["mic", "deaf"]],
    ["muted and deafened", { micOff: true, deafened: true }, ["mic", "deaf"]],
  ])("%s", (_n, flags, icons) => expect(indicatorsOf(flags)).toEqual(icons));
});

describe("deafen metadata", () => {
  it("round-trips, and undeafen clears it", () => {
    expect(parseDeafened(encodeDeafened(true))).toBe(true);
    expect(parseDeafened(encodeDeafened(false))).toBe(false);
  });
  it.each([
    ["undefined", undefined],
    ["malformed", "{deafened"],
    ["not an object", "true"],
    ["null", "null"],
    ["wrong type", '{"deafened":"yes"}'],
    ["wrong value", '{"deafened":1}'],
    ["oversized", JSON.stringify({ deafened: true, pad: "x".repeat(META_MAX) })],
  ])("%s is not deafened", (_n, raw) => expect(parseDeafened(raw)).toBe(false));
});
