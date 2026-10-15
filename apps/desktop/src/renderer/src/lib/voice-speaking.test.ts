import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LevelProbe } from "./speech-level";
import { setupVoice, type FakeRoom } from "./voice-fakes";

/** A microphone publication whose MediaStreamTrack is a unique token; levels are driven by `level[identity]`. */
const level: Record<string, number> = {};
const closed: string[] = [];
const mic = (id: string, muted = false) => ({ isMuted: muted, track: { mediaStreamTrack: { id } } }) as never;

async function inRoom() {
  const s = setupVoice();
  s.tap.mockImplementation((track) => {
    const id = (track as unknown as { id: string }).id;
    return { read: () => level[id] ?? -Infinity, close: () => void closed.push(id) } satisfies LevelProbe;
  });
  await s.voice.joinChannel("c1", "x");
  const room: FakeRoom = s.room();
  const pubs: Record<string, ReturnType<typeof mic>> = { me: mic("me") };
  room.localParticipant.getTrackPublication = (src) => (src === "microphone" ? pubs.me : undefined);
  room.addRemote("bob");
  room.remoteParticipants.get("bob")!.getTrackPublication = (src) => (src === "microphone" ? pubs.bob : undefined);
  pubs.bob = mic("bob");
  const speaking = (id: string) => s.state().participants.find((p) => p.userId === id)?.speaking;
  return { s, room, pubs, speaking };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(level)) delete level[k];
  closed.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("local speaking detection", () => {
  it("lights a remote person within one tick and releases after the hold", async () => {
    const { s, speaking } = await inRoom();
    vi.advanceTimersByTime(50);
    expect(speaking("bob")).toBe(false);
    level.bob = -30;
    s.tick(50);
    vi.advanceTimersByTime(50);
    expect(speaking("bob")).toBe(true);
    level.bob = -90;
    s.tick(400);
    vi.advanceTimersByTime(50);
    expect(speaking("bob")).toBe(false);
  });

  it("lights me, and the store is written only when someone flips", async () => {
    const { s, speaking } = await inRoom();
    level.me = -25;
    vi.advanceTimersByTime(50);
    expect(speaking("me")).toBe(true);
    const seen = s.state();
    vi.advanceTimersByTime(500); // still loud: no change, no store write
    expect(s.state()).toBe(seen);
  });

  it("LiveKit's own flag still works alone (fallback)", async () => {
    const { room, speaking } = await inRoom();
    room.fire("activeSpeakersChanged", [{ identity: "bob" }]);
    expect(speaking("bob")).toBe(true);
  });

  it("a muted local mic never shows speaking", async () => {
    const { s, speaking } = await inRoom();
    level.me = -20;
    await s.voice.toggleMic(); // micEnabled -> false
    vi.advanceTimersByTime(100);
    expect(s.state().micEnabled).toBe(false);
    expect(speaking("me")).toBe(false);
  });

  it("a muted or unsubscribed remote track is not measured", async () => {
    const { pubs, speaking } = await inRoom();
    level.bob = -20;
    vi.advanceTimersByTime(50);
    expect(speaking("bob")).toBe(true);
    pubs.bob = mic("bob", true);
    vi.advanceTimersByTime(50);
    expect(speaking("bob")).toBe(false);
    pubs.bob = mic("bob");
    vi.advanceTimersByTime(50);
    expect(speaking("bob")).toBe(true);
    pubs.bob = { isMuted: false, track: undefined } as never; // unsubscribed
    vi.advanceTimersByTime(50);
    expect(speaking("bob")).toBe(false);
    expect(closed).toContain("bob");
  });

  it("leaving stops the timer and closes every probe", async () => {
    const { s } = await inRoom();
    vi.advanceTimersByTime(50);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    s.voice.leave();
    expect(vi.getTimerCount()).toBe(0);
    expect(closed.sort()).toEqual(["bob", "me"]);
  });

  it("a server disconnect also frees everything", async () => {
    const { s, room } = await inRoom();
    vi.advanceTimersByTime(50);
    room.fire("disconnected", 4);
    expect(vi.getTimerCount()).toBe(0);
    expect(closed.length).toBe(2);
    expect(s.state().status).toBe("disconnected");
  });
});
