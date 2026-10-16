import { describe, expect, it } from "vitest";
import { encodeFlags, indicatorsOf, META_MAX, parseFlags, WATCHING_MAX } from "./voice-flags";

describe("indicatorsOf", () => {
  it.each([
    ["nothing known", {}, []],
    ["all fine", { micOff: false, deafened: false }, []],
    ["muted", { micOff: true }, ["mic"]],
    ["deafened shows both, even when the mic flag is not set", { deafened: true }, ["mic", "deaf"]],
    ["muted and deafened", { micOff: true, deafened: true }, ["mic", "deaf"]],
    ["server-muted replaces the own mic icon", { micOff: true, serverMute: true }, ["serverMic"]],
    ["server-muted but own mic on", { micOff: false, serverMute: true }, ["serverMic"]],
    ["server-deafened takes the mic too", { serverDeafen: true }, ["serverMic", "serverDeaf"]],
    ["own deafen with a server mute", { deafened: true, serverMute: true }, ["serverMic", "deaf"]],
  ])("%s", (_n, flags, icons) => expect(indicatorsOf(flags)).toEqual(icons));
});

describe("voice metadata", () => {
  it("round-trips deafen and watched streams; nothing to say is empty", () => {
    expect(parseFlags(encodeFlags({ deafened: true, watching: ["a", "b"] }))).toEqual({ deafened: true, watching: ["a", "b"] });
    expect(encodeFlags({ deafened: false, watching: [] })).toBe("");
    expect(encodeFlags({ deafened: true, watching: [] })).toBe('{"deafened":true}');
  });
  it("announces at most WATCHING_MAX streams, and reads at most that many", () => {
    const many = Array.from({ length: 20 }, (_, i) => `u${i}`);
    expect(parseFlags(encodeFlags({ deafened: false, watching: many })).watching).toHaveLength(WATCHING_MAX);
  });
  it.each([
    ["undefined", undefined],
    ["malformed", "{deafened"],
    ["not an object", "true"],
    ["null", "null"],
    ["wrong type", '{"deafened":"yes","watching":"x"}'],
    ["wrong value", '{"deafened":1}'],
    ["oversized", JSON.stringify({ deafened: true, pad: "x".repeat(META_MAX) })],
  ])("%s reads as nothing", (_n, raw) => expect(parseFlags(raw)).toEqual({ deafened: false, watching: [] }));
  it("drops non-string ids", () => expect(parseFlags('{"watching":["a",1,null,{}]}').watching).toEqual(["a"]));
});
