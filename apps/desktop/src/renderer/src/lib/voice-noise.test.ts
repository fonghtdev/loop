import { describe, expect, it } from "vitest";
import { FakeMicTrack, setupVoice } from "./voice-fakes";

/** Joined with the mic published as a track we can inspect. */
async function inRoom(level: "off" | "standard" | "strong" = "off") {
  const s = setupVoice();
  s.setLevel(level);
  const mic = new FakeMicTrack();
  await s.voice.joinChannel("c1", "Phòng họp");
  s.room().localParticipant.getTrackPublication = (src: string) => (src === "microphone" ? ({ track: mic, isMuted: false } as never) : undefined);
  return { s, mic };
}

describe("capture of a new microphone track", () => {
  it.each([
    ["off", true, 0],
    ["standard", false, 1],
    ["strong", false, 1],
  ] as const)("%s: browser noiseSuppression %s, %i processor(s)", async (level, browser, processors) => {
    const s = setupVoice();
    s.setLevel(level);
    await s.voice.joinChannel("c1", "x");
    const options = s.room().micOptions[0] as { noiseSuppression: boolean; processor?: unknown };
    expect(options.noiseSuppression).toBe(browser);
    expect(!!options.processor).toBe(!!processors);
    expect(s.processors.map((p) => p.level)).toEqual(level === "off" ? [] : [level]);
  });
});

describe("changing the level inside the room", () => {
  it("attaches the processor and switches the browser filter off, without touching the mic state", async () => {
    const { s, mic } = await inRoom("off");
    const before = { ...s.state() };
    s.setLevel("standard");
    await s.voice.applyNoise();
    expect(mic.processor).toMatchObject({ name: "standard" });
    expect(mic.constraints.at(-1)).toEqual({ noiseSuppression: false });
    expect(s.state().micEnabled).toBe(before.micEnabled);
    expect(s.room().mic).toEqual([true]); // no extra publish / mute
  });

  it("detaches it again and gives the browser filter back", async () => {
    const { s, mic } = await inRoom("standard");
    s.setLevel("standard");
    await s.voice.applyNoise();
    s.setLevel("off");
    await s.voice.applyNoise();
    expect(mic.processor).toBeNull();
    expect(mic.constraints.at(-1)).toEqual({ noiseSuppression: true });
  });

  it("standard -> strong swaps the processor", async () => {
    const { s, mic } = await inRoom("standard");
    s.setLevel("strong");
    await s.voice.applyNoise();
    expect(mic.processor).toMatchObject({ name: "strong" });
  });

  it("a muted mic stays muted and is moved too", async () => {
    const { s, mic } = await inRoom("off");
    await s.voice.toggleMic();
    expect(s.state().micEnabled).toBe(false);
    s.setLevel("strong");
    await s.voice.applyNoise();
    expect(s.state().micEnabled).toBe(false);
    expect(mic.processor).toMatchObject({ name: "strong" });
  });

  it("with no microphone track yet nothing happens, and the next capture uses the new level", async () => {
    const s = setupVoice({ canSpeak: false });
    await s.voice.joinChannel("c1", "x");
    s.setLevel("standard");
    await expect(s.voice.applyNoise()).resolves.toBeUndefined();
    expect(s.processors).toEqual([]);
  });

  it("falls back when the processor cannot be attached: mic still on, browser filter on, note shown", async () => {
    const { s, mic } = await inRoom("off");
    mic.setFails = true;
    s.setLevel("standard");
    await s.voice.applyNoise();
    expect(mic.processor).toBeNull();
    expect(mic.constraints.at(-1)).toEqual({ noiseSuppression: true });
    expect(s.state().micEnabled).toBe(true);
    expect(s.state().mediaNote).toMatch(/khử tiếng ồn/);
    expect(s.state().status).toBe("connected");
  });

  it("the processor's own failure report reaches the bar", async () => {
    const { s } = await inRoom("standard");
    s.processors[0].onFail();
    expect(s.state().mediaNote).toMatch(/khử tiếng ồn/);
  });

  it("a device switch re-applies the level (the new capture starts from the old constraints)", async () => {
    const { s, mic } = await inRoom("standard");
    await s.voice.switchDevice("audioinput", "d2");
    expect(mic.constraints.at(-1)).toEqual({ noiseSuppression: false });
  });
});
