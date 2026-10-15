import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GuildPlayer, MAX_QUEUE, PAUSE_LIMIT_MS, type Connection } from "./player.js";
import type { Track } from "./source.js";

const track = (n: number): Track => ({ id: `id${n}`, title: `song ${n}`, duration: 1 });

/** A connection whose playback ends when `finish()` is called, `stop()` is called, or with an error. */
function fakeConn() {
  const events = new EventEmitter();
  let end: (() => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const played: string[] = [];
  const conn = {
    played,
    playPcm: vi.fn((_pcm: AsyncIterable<Buffer>) => {
      return new Promise<void>((resolve, reject) => ((end = resolve), (fail = reject)));
    }),
    stop: vi.fn(() => end?.()),
    leave: vi.fn(async () => {}),
    on: (e: "disconnect", l: () => void) => events.on(e, l),
    finish: () => end?.(),
    error: (e: Error) => fail?.(e),
    drop: () => events.emit("disconnect"),
  };
  return conn satisfies Connection & Record<string, unknown>;
}

function setup() {
  const conn = fakeConn();
  const opened: { track: Track; signal: AbortSignal }[] = [];
  const source = {
    resolve: vi.fn(),
    open: (t: Track, signal: AbortSignal) => {
      opened.push({ track: t, signal });
      conn.played.push(t.id);
      return (async function* () {})(); // these tests never read the audio
    },
  };
  const said: string[] = [];
  const onClose = vi.fn();
  const player = new GuildPlayer(conn, source as any, (t) => said.push(t), onClose);
  return { conn, opened, said, onClose, player };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("GuildPlayer", () => {
  it("the first track plays at once, the others wait; each starts when the one before ends", async () => {
    const { player, conn, said } = setup();
    expect(player.add(track(1))).toBe(0);
    expect(player.add(track(2))).toBe(1);
    expect(player.add(track(3))).toBe(2);
    await tick();
    expect(conn.played).toEqual(["id1"]);
    expect(player.queued.map((t) => t.id)).toEqual(["id2", "id3"]);
    conn.finish();
    await tick();
    expect(conn.played).toEqual(["id1", "id2"]);
    expect(said).toEqual(["Đang phát: song 1", "Đang phát: song 2"]);
  });

  it("skip aborts the track's source and moves on; nothing playing -> false", async () => {
    const { player, conn, opened } = setup();
    expect(player.skip()).toBe(false);
    player.add(track(1));
    player.add(track(2));
    await tick();
    expect(player.skip()).toBe(true);
    expect(opened[0]!.signal.aborted).toBe(true);
    await tick();
    expect(conn.played).toEqual(["id1", "id2"]);
    expect(opened[1]!.signal.aborted).toBe(false);
  });

  it("a track that fails is reported and skipped, the next one plays", async () => {
    const { player, conn, said } = setup();
    player.add(track(1));
    player.add(track(2));
    await tick();
    conn.error(new Error("Video không khả dụng."));
    await tick();
    expect(said).toContain('Không phát được "song 1": Video không khả dụng.');
    expect(conn.played).toEqual(["id1", "id2"]);
  });

  it("leaves and reports closed when the queue runs dry", async () => {
    const { player, conn, onClose } = setup();
    player.add(track(1));
    await tick();
    conn.finish();
    await tick();
    expect(conn.leave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(player.current).toBeUndefined();
  });

  it("stop clears the queue, kills the source, leaves", async () => {
    const { player, conn, opened, onClose } = setup();
    player.add(track(1));
    player.add(track(2));
    await tick();
    await player.stop();
    await tick();
    expect(opened[0]!.signal.aborted).toBe(true);
    expect(conn.played).toEqual(["id1"]); // track 2 never started
    expect(player.queued).toEqual([]);
    expect(conn.leave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an unexpected disconnect cleans up the same way", async () => {
    const { player, conn, opened, onClose } = setup();
    player.add(track(1));
    player.add(track(2));
    await tick();
    conn.drop();
    await tick();
    expect(opened[0]!.signal.aborted).toBe(true);
    expect(conn.played).toEqual(["id1"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it(`holds at most ${MAX_QUEUE} waiting tracks`, async () => {
    const { player } = setup();
    player.add(track(0)); // playing
    for (let i = 1; i <= MAX_QUEUE; i++) expect(player.add(track(i))).toBe(i);
    expect(player.add(track(99))).toBeNull();
    expect(player.queued).toHaveLength(MAX_QUEUE);
  });

  it("next puts a track first in line, add puts it last; both report how many are ahead", async () => {
    const { player } = setup();
    expect(player.add(track(1))).toBe(0); // plays at once
    expect(player.add(track(2))).toBe(1);
    expect(player.add(track(3))).toBe(2);
    expect(player.add(track(4), true)).toBe(1); // right after the one playing
    expect(player.queued.map((t) => t.id)).toEqual(["id4", "id2", "id3"]);
    expect(player.add(track(5), true)).toBe(1); // the latest `next` is first
    expect(player.queued.map((t) => t.id)).toEqual(["id5", "id4", "id2", "id3"]);
  });

  it("next on an idle player plays it at once, and a full queue refuses it", async () => {
    const { player, conn } = setup();
    expect(player.add(track(1), true)).toBe(0);
    await tick();
    expect(conn.played).toEqual(["id1"]);
    for (let i = 2; i <= MAX_QUEUE + 1; i++) player.add(track(i));
    expect(player.add(track(99), true)).toBeNull();
  });

  describe("pause / resume", () => {
    /** A connection that really reads the audio it is given, one chunk per `pull()`, like the SDK's paced loop. */
    function reading() {
      const { conn, player, opened, said, onClose } = setup();
      const chunks = Array.from({ length: 50 }, (_, i) => Buffer.from([i]));
      let given = 0;
      let wake: (() => void) | undefined;
      conn.playPcm.mockImplementation(async (pcm: AsyncIterable<Buffer>) => {
        for await (const _chunk of pcm) {
          given++;
          wake?.();
        }
      });
      const source = {
        resolve: vi.fn(),
        open: (t: Track, signal: AbortSignal) => {
          opened.push({ track: t, signal });
          conn.played.push(t.id);
          return (async function* () {
            for (const c of chunks) {
              if (signal.aborted) return;
              await tick();
              yield c;
            }
          })();
        },
      };
      const p = new GuildPlayer(conn, source as any, (t) => said.push(t), onClose);
      return { conn, p, said, onClose, given: () => given, opened };
    }

    it("pause holds the audio, resume continues from the same spot, both only when they apply", async () => {
      const { p, given } = reading();
      expect(p.pause()).toBe(false); // nothing playing
      expect(p.resume()).toBe(false);
      p.add(track(1));
      await new Promise((r) => setTimeout(r, 15));
      expect(given()).toBeGreaterThan(0);
      expect(p.pause()).toBe(true);
      expect(p.pause()).toBe(false); // already paused
      expect(p.isPaused).toBe(true);
      await new Promise((r) => setTimeout(r, 5)); // a chunk already on its way may still land
      const frozen = given();
      await new Promise((r) => setTimeout(r, 30));
      expect(given()).toBe(frozen); // nothing more is handed out while paused
      expect(p.resume()).toBe(true);
      expect(p.isPaused).toBe(false);
      await new Promise((r) => setTimeout(r, 30));
      expect(given()).toBeGreaterThan(frozen);
      expect(p.resume()).toBe(false);
    });

    it("skip or stop while paused wakes the gate: the next track plays / everything is released", async () => {
      const { p, conn, given } = reading();
      p.add(track(1));
      p.add(track(2));
      await new Promise((r) => setTimeout(r, 10));
      p.pause();
      expect(p.skip()).toBe(true);
      expect(p.isPaused).toBe(false); // the next track is not stuck behind the old pause
      await new Promise((r) => setTimeout(r, 20));
      expect(conn.played).toEqual(["id1", "id2"]);
      const before = given();
      await new Promise((r) => setTimeout(r, 20));
      expect(given()).toBeGreaterThan(before);
      p.pause();
      await p.stop();
      expect(p.isPaused).toBe(false);
      expect(conn.leave).toHaveBeenCalled();
    });

    it("a pause nobody ends stops the player after PAUSE_LIMIT_MS", async () => {
      vi.useFakeTimers();
      try {
        const { p, onClose } = reading();
        p.add(track(1));
        await vi.advanceTimersByTimeAsync(5);
        expect(p.pause()).toBe(true);
        await vi.advanceTimersByTimeAsync(PAUSE_LIMIT_MS - 1000);
        expect(onClose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(onClose).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resume cancels the pause timer (it is cleared, so it can never stop a playing track later)", async () => {
      vi.useFakeTimers();
      try {
        const { p } = reading();
        p.add(track(1));
        await vi.advanceTimersByTimeAsync(5);
        p.pause();
        const before = vi.getTimerCount();
        p.resume();
        expect(vi.getTimerCount()).toBe(before - 1); // exactly the pause timer is gone
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
