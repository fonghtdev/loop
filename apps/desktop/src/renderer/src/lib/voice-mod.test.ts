import { Permission as P } from "@loop/shared";
import { describe, expect, it } from "vitest";
import type { Channel } from "./permissions";
import { moderationNotices, voiceModButtons } from "./voice-mod";

const ch = (id: string) => ({ id, guildId: "g", name: id, type: "VOICE", overwrites: [] }) as unknown as Channel;
const channels = [ch("a"), ch("b")];
const base = { userId: "t", selfId: "me", canActOn: true, channels, live: null, lists: { a: [{ userId: "t", username: "t" }] }, bitsOf: () => P.MUTE_MEMBERS | P.DEAFEN_MEMBERS };

describe("voiceModButtons", () => {
  it("offers mute and deafen for someone in a voice channel when we hold both bits there", () => {
    expect(voiceModButtons(base)).toEqual({ channel: channels[0], buttons: [{ label: "voice.mod.mute", body: { mute: true } }, { label: "voice.mod.deafen", body: { deafen: true } }] });
  });
  it("follows the server state: unmute / undeafen", () => {
    const r = voiceModButtons({ ...base, lists: { a: [{ userId: "t", username: "t", serverMute: true, serverDeafen: true }] } });
    expect(r?.buttons.map((b) => b.label)).toEqual(["voice.mod.unmute", "voice.mod.undeafen"]);
  });
  it("the bits are read in THE channel they sit in", () => {
    const bitsOf = (c: Channel) => (c.id === "b" ? P.MUTE_MEMBERS : 0);
    expect(voiceModButtons({ ...base, bitsOf })).toBeNull();
    expect(voiceModButtons({ ...base, bitsOf, lists: { b: [{ userId: "t", username: "t" }] } })?.buttons.map((b) => b.label)).toEqual(["voice.mod.mute"]);
  });
  it("nothing for ourselves, someone at or above us, or someone not in voice", () => {
    expect(voiceModButtons({ ...base, userId: "me", lists: { a: [{ userId: "me", username: "me" }] } })).toBeNull();
    expect(voiceModButtons({ ...base, canActOn: false })).toBeNull();
    expect(voiceModButtons({ ...base, lists: {} })).toBeNull();
  });
});

describe("moderationNotices", () => {
  it("one line per changed flag, none for an echo", () => {
    expect(moderationNotices({ serverMuted: false, serverDeafened: false }, { serverMute: true, serverDeafen: false }, "Mod")).toEqual(["Mod đã tắt mic của bạn"]);
    expect(moderationNotices({ serverMuted: true, serverDeafened: true }, { serverMute: false, serverDeafen: false }, "Mod")).toEqual(["Mod đã bật lại loa cho bạn", "Mod đã bật lại mic cho bạn"]);
    expect(moderationNotices({ serverMuted: true, serverDeafened: false }, { serverMute: true, serverDeafen: false }, "Mod")).toEqual([]);
  });
});
