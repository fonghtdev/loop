import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GuildPlayer, MAX_QUEUE, type Connection } from "./player.js";
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
    playPcm: vi.fn((pcm: AsyncIterable<Buffer>) => {
      played.push((pcm as any).id);
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
  const source = { resolve: vi.fn(), open: (t: Track, signal: AbortSignal) => (opened.push({ track: t, signal }), Object.assign({ [Symbol.asyncIterator]: () => ({}) as any }, { id: t.id })) };
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
});
