import { describe, expect, it } from "vitest";
import { audioTrack, setupVoice } from "./voice-fakes";
import { createVoiceVolumes, DEFAULT_USER_VOLUME, parseVoiceVolumes, voiceVolumeKey } from "./voice-volume";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe("parseVoiceVolumes", () => {
  it("keeps valid non-default entries, clamps to 0-200% and drops defaults", () => {
    expect(parseVoiceVolumes('{"a":{"volume":1.5},"b":{"muted":true},"c":{"volume":9},"d":{"volume":-3}}')).toEqual({ a: { volume: 1.5 }, b: { muted: true }, c: { volume: 2 }, d: { volume: 0 } });
    expect(parseVoiceVolumes('{"a":{"volume":1,"muted":false},"b":{}}')).toEqual({});
  });
  it("repairs each field and entry on its own, and survives junk", () => {
    expect(parseVoiceVolumes('{"a":{"volume":"loud","muted":"yes"},"b":5,"c":null,"d":{"volume":0.5}}')).toEqual({ d: { volume: 0.5 } });
    for (const junk of ["{nope", "[1]", "7", "null", null, undefined]) expect(parseVoiceVolumes(junk)).toEqual({});
  });
});

describe("createVoiceVolumes", () => {
  it("saves per account under loop.voicevol.<id>, and another account or sign-out sees nothing", () => {
    const store = memory();
    const v = createVoiceVolumes(() => store);
    v.load("me");
    v.set("u2", { volume: 1.5 });
    v.set("u3", { muted: true });
    expect(JSON.parse(store.data.get(voiceVolumeKey("me"))!)).toEqual({ u2: { volume: 1.5 }, u3: { muted: true } });
    v.load("other");
    expect(v.get("u2")).toEqual(DEFAULT_USER_VOLUME);
    v.load("me");
    expect(v.get("u2")).toEqual({ volume: 1.5, muted: false });
    v.load(null);
    expect(v.get("u3")).toEqual(DEFAULT_USER_VOLUME);
  });
  it("going back to the defaults removes the entry, so the stored value stays small", () => {
    const store = memory();
    const v = createVoiceVolumes(() => store);
    v.load("me");
    v.set("u2", { volume: 0.5, muted: true });
    v.set("u2", { volume: 1, muted: false });
    expect(store.data.get(voiceVolumeKey("me"))).toBe("{}");
  });
  it("clamps what is set; a blocked storage still keeps the choice for this run", () => {
    const v = createVoiceVolumes(() => ({ getItem: () => null, setItem: () => { throw new Error("full"); } }));
    v.load("me");
    v.set("u2", { volume: 7 });
    expect(v.get("u2").volume).toBe(2);
  });
  it("tells subscribers about changes (the card re-renders)", () => {
    const v = createVoiceVolumes(() => undefined);
    let n = 0;
    const off = v.subscribe(() => n++);
    v.load("me");
    v.set("u2", { muted: true });
    off();
    v.set("u2", { muted: false });
    expect(n).toBe(2);
  });
});

describe("a person's microphone volume in the voice session", () => {
  const mic = () => ({ ...(audioTrack() as object), source: "microphone" }) as never;
  const joinedWith = async () => {
    const s = setupVoice();
    await s.voice.joinChannel("c1", "Phòng họp");
    const lan = { identity: "u2", name: "Lan", getTrackPublication: () => undefined };
    s.room().remoteParticipants.set("u2", lan);
    s.room().fire("participantConnected", lan);
    return { s, lan };
  };

  it("applies the saved volume when their track appears, and the slider goes above 100%", async () => {
    const { s, lan } = await joinedWith();
    s.userVolumes.set("u2", { volume: 1.6 });
    const track = mic();
    s.room().fire("trackSubscribed", track, undefined, lan);
    expect(s.sink.volumes.get(track)).toBe(1.6);
    s.voice.setUserVolume("u2", { volume: 0.25 });
    expect(s.sink.volumes.get(track)).toBe(0.25);
    s.voice.setUserVolume("u2", { volume: 9 });
    expect(s.sink.volumes.get(track)).toBe(2);
  });

  it("mute-for-me is silent, and unmuting brings the slider back", async () => {
    const { s, lan } = await joinedWith();
    const track = mic();
    s.room().fire("trackSubscribed", track, undefined, lan);
    s.voice.setUserVolume("u2", { volume: 1.5 });
    s.voice.setUserVolume("u2", { muted: true });
    expect(s.sink.volumes.get(track)).toBe(0);
    s.voice.setUserVolume("u2", { muted: false });
    expect(s.sink.volumes.get(track)).toBe(1.5);
  });

  it("deafen silences it and undeafen restores the person's volume", async () => {
    const { s, lan } = await joinedWith();
    const track = mic();
    s.userVolumes.set("u2", { volume: 1.5 });
    s.room().fire("trackSubscribed", track, undefined, lan);
    await s.voice.toggleDeafen();
    expect(s.sink.volumes.get(track)).toBe(0);
    await s.voice.toggleDeafen();
    expect(s.sink.volumes.get(track)).toBe(1.5);
  });

  it("is the microphone only: a stream's sound keeps its own 0-100% slider", async () => {
    const { s, lan } = await joinedWith();
    s.userVolumes.set("u2", { volume: 1.8, muted: true });
    const stream = { kind: "audio", source: "screen_share_audio", attach: () => null, detach: () => undefined } as never;
    s.room().fire("trackSubscribed", stream, undefined, lan);
    expect(s.sink.volumes.get(stream)).toBe(0); // not watched yet: silent regardless of the person's slider
    s.voice.setUserVolume("u2", { volume: 1.2 });
    expect(s.sink.volumes.get(stream)).toBe(0); // the person's slider did not move the stream
  });

  it("a track that went away is not touched by later changes", async () => {
    const { s, lan } = await joinedWith();
    const track = mic();
    s.room().fire("trackSubscribed", track, undefined, lan);
    s.room().fire("trackUnsubscribed", track, undefined, lan);
    s.sink.volumes.clear();
    s.voice.setUserVolume("u2", { volume: 1.5 });
    expect(s.sink.volumes.size).toBe(0);
  });
});
