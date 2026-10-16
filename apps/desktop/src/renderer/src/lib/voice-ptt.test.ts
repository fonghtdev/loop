import { describe, expect, it } from "vitest";
import { setupVoice } from "./voice-fakes";

const joined = async () => {
  const s = setupVoice();
  await s.voice.joinChannel("c1", "Phòng họp");
  return s;
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("push-to-talk in the voice session", () => {
  it("voice activity (default): the mic opens on join and the key does nothing", async () => {
    const s = await joined();
    expect(s.room().mic).toEqual([true]);
    s.voice.setPttHeld(true);
    s.voice.setPttHeld(false);
    await settle();
    expect(s.room().mic).toEqual([true]);
  });

  it("push-to-talk on: the mic is closed until the key goes down, then closed again on release", async () => {
    const s = await joined();
    s.voice.setPtt(true);
    await settle();
    expect(s.room().mic).toEqual([true, false]);
    s.voice.setPttHeld(true);
    await settle();
    s.voice.setPttHeld(false);
    await settle();
    expect(s.room().mic).toEqual([true, false, true, false]);
    expect(s.state().micEnabled).toBe(true); // the user's own switch is not touched by the key
  });

  it("a user who muted themselves stays silent when the key is held", async () => {
    const s = await joined();
    s.voice.setPtt(true);
    await s.voice.toggleMic(); // manual mute
    await settle();
    const before = s.room().mic.length;
    s.voice.setPttHeld(true);
    await settle();
    expect(s.room().mic.at(-1)).toBe(false);
    expect(s.state().micEnabled).toBe(false);
    expect(s.room().mic.slice(before).every((on) => !on)).toBe(true);
  });

  it("a deafened user stays silent when the key is held, and the key opens the mic again after undeafen", async () => {
    const s = await joined();
    s.voice.setPtt(true);
    s.voice.setPttHeld(true);
    await settle();
    await s.voice.toggleDeafen();
    expect(s.room().mic.at(-1)).toBe(false);
    s.voice.setPttHeld(false);
    s.voice.setPttHeld(true);
    await settle();
    expect(s.room().mic.at(-1)).toBe(false);
    await s.voice.toggleDeafen(); // restores the mic as it was: held, so open
    await settle();
    expect(s.room().mic.at(-1)).toBe(true);
  });

  it("switching push-to-talk off in the room gives the mic back to the user's own switch", async () => {
    const s = await joined();
    s.voice.setPtt(true);
    await settle();
    s.voice.setPtt(false);
    await settle();
    expect(s.room().mic.at(-1)).toBe(true);
  });

  it("leaving with the key held leaves no held key behind; the mode itself is kept for the next room", async () => {
    const s = await joined();
    s.voice.setPtt(true);
    s.voice.setPttHeld(true);
    s.voice.leave();
    expect(s.state()).toMatchObject({ pttHeld: false, ptt: true });
    await s.voice.joinChannel("c2", "Khác");
    await settle();
    expect(s.room().mic.at(-1)).toBe(false); // joined muted: push-to-talk, key not held
  });

  it("the key is ignored outside push-to-talk even if it arrives (a stale event)", async () => {
    const s = await joined();
    s.voice.setPttHeld(true);
    await settle();
    expect(s.room().mic).toEqual([true]);
  });
});
