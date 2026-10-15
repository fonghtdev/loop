import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { META_TIMEOUT_MS, MAX_DURATION_SECONDS, UserError, audioArgs, createSource, metaArgs, toTrack } from "./source.js";

describe("spawn arguments", () => {
  it("search goes inside ytsearch1: and after --; a query that looks like a flag stays data", () => {
    const args = metaArgs("--exec rm -rf");
    expect(args.slice(-2)).toEqual(["--", "ytsearch1:--exec rm -rf"]);
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--dump-single-json");
  });

  it("cookies come first and never move the target: the target stays after --", () => {
    expect(metaArgs("x", "/tmp/c.txt").slice(0, 2)).toEqual(["--cookies", "/tmp/c.txt"]);
    expect(metaArgs("x", "/tmp/c.txt").slice(-2)).toEqual(["--", "ytsearch1:x"]);
    expect(audioArgs("dQw4w9WgXcQ", "/tmp/c.txt").slice(0, 2)).toEqual(["--cookies", "/tmp/c.txt"]);
    expect(metaArgs("x")).not.toContain("--cookies");
    expect(audioArgs("dQw4w9WgXcQ")).not.toContain("--cookies");
  });

  it("a link goes after -- as is; the audio command is built from the validated id only", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1";
    expect(metaArgs(url).slice(-2)).toEqual(["--", url]);
    const args = audioArgs("dQw4w9WgXcQ");
    expect(args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    expect(args).toContain("--no-playlist");
  });
});

describe("toTrack", () => {
  const video = { id: "dQw4w9WgXcQ", title: "Song", duration: 200 };

  it("reads a video, or the first entry of a search result; cleans and clips the title", () => {
    expect(toTrack(video)).toEqual(video);
    expect(toTrack({ entries: [video] })).toEqual(video);
    const t = toTrack({ ...video, title: `a\nb\u0000${"x".repeat(200)}` });
    expect(t.title).not.toMatch(/[\n\u0000]/);
    expect(t.title.length).toBeLessThanOrEqual(80);
  });

  it("refuses nothing found, live streams, too long videos and odd ids", () => {
    expect(() => toTrack({ entries: [] })).toThrow(UserError);
    expect(() => toTrack({ ...video, is_live: true, duration: null })).toThrow(/live/);
    expect(() => toTrack({ ...video, duration: MAX_DURATION_SECONDS + 1 })).toThrow(/dài/);
    expect(toTrack({ ...video, duration: MAX_DURATION_SECONDS }).id).toBe(video.id);
    expect(() => toTrack({ ...video, id: "../../etc" })).toThrow(UserError);
  });
});

/** A child process that only has the parts the source touches. */
function fakeChild(opts: { stdout?: PassThrough } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: opts.stdout ?? new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
  return child;
}

describe("createSource", () => {
  it("spawns without a shell, resolves metadata from stdout", async () => {
    const dl = fakeChild();
    const spawnFn = vi.fn(() => dl) as any;
    const pending = createSource({ spawnFn }).resolve("some song");
    dl.stdout.end(JSON.stringify({ entries: [{ id: "dQw4w9WgXcQ", title: "Song", duration: 10 }] }));
    dl.emit("close", 0);
    expect(await pending).toMatchObject({ id: "dQw4w9WgXcQ" });
    const [bin, args, options] = spawnFn.mock.calls[0];
    expect(bin).toBe("yt-dlp");
    expect(Array.isArray(args)).toBe(true);
    expect(options.shell).toBeUndefined();
  });

  it("explains a failed lookup and a missing binary", async () => {
    const dl = fakeChild();
    const pending = createSource({ spawnFn: (() => dl) as any }).resolve("x");
    dl.stderr.write("ERROR: Video unavailable");
    dl.emit("close", 1);
    await expect(pending).rejects.toThrow("Video không khả dụng.");

    const missing = fakeChild();
    const p2 = createSource({ spawnFn: (() => missing) as any }).resolve("x");
    missing.emit("error", new Error("ENOENT"));
    await expect(p2).rejects.toThrow(/đã cài chưa/);
  });

  it("the bot check is reported as YouTube blocking the host, not as an unavailable video", async () => {
    const dl = fakeChild();
    const pending = createSource({ spawnFn: (() => dl) as any }).resolve("x");
    dl.stderr.write("ERROR: [youtube] kFbbTrkiY04: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies");
    dl.emit("close", 1);
    await expect(pending).rejects.toThrow(/chặn máy chủ/);
    const age = fakeChild();
    const p2 = createSource({ spawnFn: (() => age) as any }).resolve("x");
    age.stderr.write("ERROR: Sign in to confirm your age");
    age.emit("close", 1);
    await expect(p2).rejects.toThrow("Video không khả dụng.");
  });

  it("a lookup killed by the time limit says it was too slow (not 'not found') and the limit allows a slow host minutes", async () => {
    expect(META_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    const dl = fakeChild();
    const spawnFn = vi.fn(() => dl) as any;
    const pending = createSource({ spawnFn }).resolve("x");
    expect(spawnFn.mock.calls[0][2]).toMatchObject({ timeout: META_TIMEOUT_MS });
    dl.emit("close", null, "SIGTERM");
    await expect(pending).rejects.toThrow("quá chậm");
  });

  const track = { id: "dQw4w9WgXcQ", title: "t", duration: 1 };
  function openFake() {
    const dl = fakeChild();
    const ff = fakeChild();
    const spawnFn = vi.fn((bin: string) => (bin === "yt-dlp" ? dl : ff)) as any;
    return { dl, ff, spawnFn, source: createSource({ spawnFn }) };
  }

  it("yields what ffmpeg outputs, and starts yt-dlp then ffmpeg without a shell", async () => {
    const { ff, spawnFn, source } = openFake();
    const it = source.open(track, new AbortController().signal)[Symbol.asyncIterator]();
    const first = it.next();
    ff.stdout.write(Buffer.from([1, 2]));
    expect((await first).value).toEqual(Buffer.from([1, 2]));
    expect(spawnFn.mock.calls.map((c: any[]) => c[0])).toEqual(["yt-dlp", "ffmpeg"]);
    expect(spawnFn.mock.calls.every((c: any[]) => c[2].shell === undefined)).toBe(true);
    await it.return!();
  });

  it("kills both processes when the signal aborts, and when the consumer stops reading", async () => {
    const a = openFake();
    const ctl = new AbortController();
    const done = (async () => {
      for await (const _ of a.source.open(track, ctl.signal)); // ends without error when aborted
    })();
    ctl.abort();
    expect(a.dl.kill).toHaveBeenCalled();
    expect(a.ff.kill).toHaveBeenCalled();
    a.ff.stdout.end(); // a real ffmpeg closes its pipe once killed
    await done;

    const b = openFake();
    const it = b.source.open(track, new AbortController().signal)[Symbol.asyncIterator]();
    const first = it.next();
    b.ff.stdout.write(Buffer.from([1]));
    await first;
    await it.return!();
    expect(b.dl.kill).toHaveBeenCalled();
    expect(b.ff.kill).toHaveBeenCalled();
  });

  it("throws the explained error when no audio came out", async () => {
    const { dl, ff, source } = openFake();
    const drained = (async () => {
      for await (const _ of source.open(track, new AbortController().signal));
    })();
    dl.stderr.write("ERROR: Private video");
    await new Promise((r) => setTimeout(r, 10));
    ff.stdout.end();
    await expect(drained).rejects.toThrow("Video không khả dụng.");
  });
});
