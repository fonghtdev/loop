import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TtlLru } from "./cache.js";
import { DIRECT_TTL_MS, META_TIMEOUT_MS, MAX_DURATION_SECONDS, UserError, audioArgs, classifyFailure, createSource, ffmpegArgs, metaArgs, parseSources, toTrack, type Track } from "./source.js";

const BOT_CHECK = "ERROR: [youtube] kFbbTrkiY04: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies";
const video = { id: "dQw4w9WgXcQ", title: "Song", duration: 200 };
const stream = { url: "https://rr1.googlevideo.com/a", http_headers: { "User-Agent": "UA" }, protocol: "https" };

describe("spawn arguments", () => {
  it("one run asks for the title and the stream URL together; the target stays after -- so it can never be an option", () => {
    const args = metaArgs("ytsearch1:--exec rm -rf", "youtube");
    expect(args.slice(-2)).toEqual(["--", "ytsearch1:--exec rm -rf"]);
    expect(args).toEqual(expect.arrayContaining(["--print", "--no-playlist", "--no-warnings", "--no-update", "bestaudio/best"]));
    expect(args.join(" ")).toMatch(/url,http_headers/);
    expect(args).not.toContain("--dump-single-json");
  });

  it("cookies and the player client go only to YouTube and come before the target", () => {
    const yt = metaArgs("ytsearch1:x", "youtube", { cookies: "/tmp/c.txt", ytClient: "android_vr" });
    expect(yt.slice(0, 2)).toEqual(["--cookies", "/tmp/c.txt"]);
    expect(yt).toContain("youtube:player_client=android_vr");
    expect(yt.slice(-2)).toEqual(["--", "ytsearch1:x"]);
    expect(metaArgs("scsearch1:x", "soundcloud", { cookies: "/tmp/c.txt", ytClient: "android_vr" }).join(" ")).not.toMatch(/cookies|player_client/);
    expect(metaArgs("ytsearch1:x", "youtube")).not.toContain("--cookies");
    expect(audioArgs("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "/tmp/c.txt").slice(0, 2)).toEqual(["--cookies", "/tmp/c.txt"]);
    expect(audioArgs("https://soundcloud.com/a/b", "soundcloud", "/tmp/c.txt")).not.toContain("--cookies");
  });

  it("ffmpeg reads the pipe, or the resolved stream URL with yt-dlp's headers (no CR/LF smuggling); playlists get no reconnect flags", () => {
    expect(ffmpegArgs()).toEqual(expect.arrayContaining(["-i", "pipe:0", "s16le"]));
    const d = { url: "https://rr1.googlevideo.com/a", headers: { "User-Agent": "UA\r\nX-Evil: 1", Accept: "*/*" }, at: 0 };
    const args = ffmpegArgs(d);
    expect(args).toContain("-nostdin");
    expect(args).toContain("-reconnect");
    expect(args[args.indexOf("-headers") + 1]).toBe("User-Agent: UA X-Evil: 1\r\nAccept: */*\r\n");
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", d.url]);
    expect(ffmpegArgs({ ...d, url: "https://x/playlist.m3u8?expires=1" })).not.toContain("-reconnect");
  });
});

describe("classifyFailure", () => {
  it("tells a refused host (try another source) from an unplayable video", () => {
    for (const e of [BOT_CHECK, "ERROR: unable to download video data: HTTP Error 403: Forbidden", "HTTP Error 429: Too Many Requests", "The current session has been rate-limited by YouTube", "ERROR: [youtube] x: Sign in to confirm you're not a bot"])
      expect(classifyFailure(e)).toBe("blocked");
    for (const e of ["ERROR: Video unavailable", "ERROR: Private video", "ERROR: Sign in to confirm your age", "ERROR: blocked it in your country on copyright grounds"])
      expect(classifyFailure(e)).toBe("unavailable");
    expect(classifyFailure("")).toBe("other");
    expect(classifyFailure("ERROR: something odd")).toBe("other");
  });
});

describe("parseSources", () => {
  it("defaults to YouTube then SoundCloud; the env sets order or disables one; junk is ignored", () => {
    expect(parseSources()).toEqual(["youtube", "soundcloud"]);
    expect(parseSources("")).toEqual(["youtube", "soundcloud"]);
    expect(parseSources("nope")).toEqual(["youtube", "soundcloud"]);
    expect(parseSources("SoundCloud, youtube")).toEqual(["soundcloud", "youtube"]);
    expect(parseSources("soundcloud")).toEqual(["soundcloud"]);
    expect(parseSources("youtube,youtube,bad")).toEqual(["youtube"]);
  });
});

describe("toTrack", () => {
  it("reads a video, or the first entry of a search result; cleans and clips the title; keeps the page, not the stream, as identity", () => {
    const page = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(toTrack(video, "youtube")).toEqual({ ...video, source: "youtube", page });
    expect(toTrack({ entries: [video] }, "youtube").id).toBe(video.id);
    const t = toTrack({ ...video, title: `a\nb\u0000${"x".repeat(200)}` }, "youtube");
    expect(t.title).not.toMatch(/[\n\u0000]/);
    expect(t.title.length).toBeLessThanOrEqual(80);
  });

  it("keeps the stream URL only when ffmpeg can read it directly", () => {
    expect(toTrack({ ...video, ...stream }, "youtube").direct).toMatchObject({ url: stream.url, headers: stream.http_headers });
    expect(toTrack({ ...video, ...stream, protocol: "m3u8_native" }, "youtube").direct).toBeDefined();
    expect(toTrack({ ...video, ...stream, protocol: "http_dash_segments" }, "youtube").direct).toBeUndefined();
    expect(toTrack({ ...video, ...stream, url: "file:///etc/passwd" }, "youtube").direct).toBeUndefined();
  });

  it("refuses nothing found, live streams, too long videos and odd YouTube ids", () => {
    expect(() => toTrack({ entries: [] }, "youtube")).toThrow(UserError);
    expect(() => toTrack({ ...video, is_live: true, duration: null }, "youtube")).toThrow(/live/);
    expect(() => toTrack({ ...video, duration: MAX_DURATION_SECONDS + 1 }, "youtube")).toThrow(/dài/);
    expect(toTrack({ ...video, duration: MAX_DURATION_SECONDS }, "youtube").id).toBe(video.id);
    expect(() => toTrack({ ...video, id: "../../etc" }, "youtube")).toThrow(UserError);
  });

  it("SoundCloud and plain links use the page yt-dlp reports; a plain file without duration is fine, a SoundCloud id is not an 11-char id", () => {
    const sc = { id: "417474360", title: "Mix", duration: 60, webpage_url: "https://soundcloud.com/a/mix" };
    expect(toTrack(sc, "soundcloud")).toMatchObject({ source: "soundcloud", page: sc.webpage_url, id: sc.id });
    expect(toTrack({ id: "x", title: "a.mp3", webpage_url: "https://example.com/a.mp3" }, "url")).toMatchObject({ duration: 0, page: "https://example.com/a.mp3" });
    expect(toTrack({ id: "x", title: "a" }, "url", "https://example.com/a.mp3").page).toBe("https://example.com/a.mp3");
    expect(() => toTrack({ id: "x", title: "a", webpage_url: "javascript:1" }, "url")).toThrow(UserError);
    expect(() => toTrack({ ...sc, duration: undefined }, "soundcloud")).toThrow(/live/);
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
    const pending = createSource({ sources: ["youtube"], spawnFn }).resolve("some song");
    dl.stdout.end(JSON.stringify({ entries: [{ id: "dQw4w9WgXcQ", title: "Song", duration: 10 }] }));
    dl.emit("close", 0);
    expect(await pending).toMatchObject({ id: "dQw4w9WgXcQ" });
    const [bin, args, options] = spawnFn.mock.calls[0];
    expect(bin).toBe("yt-dlp");
    expect(args.slice(-2)).toEqual(["--", "ytsearch1:some song"]);
    expect(Array.isArray(args)).toBe(true);
    expect(options.shell).toBeUndefined();
  });

  it("explains a failed lookup and a missing binary", async () => {
    const dl = fakeChild();
    const pending = createSource({ sources: ["youtube"], spawnFn: (() => dl) as any }).resolve("x");
    dl.stderr.write("ERROR: Video unavailable");
    dl.emit("close", 1);
    await expect(pending).rejects.toThrow("Video không khả dụng.");

    const missing = fakeChild();
    const p2 = createSource({ sources: ["youtube"], spawnFn: (() => missing) as any }).resolve("x");
    missing.emit("error", new Error("ENOENT"));
    await expect(p2).rejects.toThrow(/đã cài chưa/);
  });

  it("the bot check is reported as YouTube blocking the host, not as an unavailable video", async () => {
    const dl = fakeChild();
    const pending = createSource({ sources: ["youtube"], spawnFn: (() => dl) as any }).resolve("x");
    dl.stderr.write("ERROR: [youtube] kFbbTrkiY04: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies");
    dl.emit("close", 1);
    await expect(pending).rejects.toThrow(/chặn máy chủ/);
    const age = fakeChild();
    const p2 = createSource({ sources: ["youtube"], spawnFn: (() => age) as any }).resolve("x");
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

  const track: Track = { id: "dQw4w9WgXcQ", title: "t", duration: 1, source: "youtube", page: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
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

/** yt-dlp that answers per target (the last argument): `{ out }` succeeds, `{ err }` fails with exit 1, `{ hang }` never ends until killed. */
function scripted(answers: Record<string, { out?: object; err?: string; hang?: boolean }>) {
  const calls: string[][] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn = vi.fn((_bin: string, args: string[]) => {
    calls.push(args);
    const child = fakeChild();
    children.push(child);
    const a = answers[args.at(-1)!] ?? { err: "ERROR: nothing scripted" };
    child.kill.mockImplementation(() => child.emit("close", null, "SIGTERM"));
    if (!a.hang)
      setImmediate(() => {
        if (a.out) child.stdout.write(JSON.stringify(a.out));
        if (a.err) child.stderr.write(a.err);
        child.emit("close", a.out ? 0 : 1);
      });
    return child;
  }) as any;
  return { spawnFn, calls, children };
}
const yt = { ...video, ...stream, webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
const sc = { id: "417474360", title: "SC Mix", duration: 60, webpage_url: "https://soundcloud.com/a/mix", url: "https://playback.sc/x.m3u8", http_headers: {}, protocol: "m3u8_native" };

describe("source order and fallback", () => {
  it("YouTube first; when it refuses the host the search moves to SoundCloud, tells the user, and the track says where it came from", async () => {
    const { spawnFn, calls } = scripted({ "ytsearch1:lofi": { err: BOT_CHECK }, "scsearch1:lofi": { out: sc } });
    const notes: string[] = [];
    const track = await createSource({ spawnFn }).resolve("lofi", (t) => notes.push(t));
    expect(track).toMatchObject({ source: "soundcloud", page: sc.webpage_url });
    expect(calls.map((a) => a.at(-1))).toEqual(["ytsearch1:lofi", "scsearch1:lofi"]);
    expect(notes).toEqual(["YouTube chặn máy chủ, đang thử SoundCloud..."]);
  });

  it("a working YouTube is not followed by SoundCloud; `sc` and MUSIC_SOURCES change the order; one disabled source is never asked", async () => {
    const a = scripted({ "ytsearch1:x": { out: yt } });
    expect((await createSource({ spawnFn: a.spawnFn }).resolve("x")).source).toBe("youtube");
    expect(a.calls).toHaveLength(1);

    const b = scripted({ "scsearch1:x": { out: sc } });
    expect((await createSource({ spawnFn: b.spawnFn }).resolve("sc x")).source).toBe("soundcloud");
    expect(b.calls.map((c) => c.at(-1))).toEqual(["scsearch1:x"]);

    const c = scripted({ "scsearch1:x": { out: sc } });
    await createSource({ spawnFn: c.spawnFn, sources: parseSources("soundcloud") }).resolve("x");
    expect(c.calls.map((x) => x.at(-1))).toEqual(["scsearch1:x"]);
  });

  it("an unplayable video (not a blocked host) is reported as is and does not fall back; a timeout does not either", async () => {
    const a = scripted({ "ytsearch1:x": { err: "ERROR: Private video" } });
    await expect(createSource({ spawnFn: a.spawnFn }).resolve("x")).rejects.toThrow("Video không khả dụng.");
    expect(a.calls).toHaveLength(1);
  });

  it("nothing on any source gives one clear message; every source blocked says so; one blocked source keeps its own advice", async () => {
    const none = scripted({ "ytsearch1:x": { out: { entries: [] } }, "scsearch1:x": { out: { entries: [] } } });
    await expect(createSource({ spawnFn: none.spawnFn }).resolve("x")).rejects.toThrow("Không tìm thấy bài nào (đã thử: YouTube, SoundCloud).");
    const blocked = scripted({ "ytsearch1:x": { err: BOT_CHECK }, "scsearch1:x": { err: "HTTP Error 403: Forbidden" } });
    await expect(createSource({ spawnFn: blocked.spawnFn }).resolve("x")).rejects.toThrow(/đều chặn máy chủ/);
    const only = scripted({ "ytsearch1:x": { err: BOT_CHECK } });
    await expect(createSource({ spawnFn: only.spawnFn, sources: ["youtube"] }).resolve("x")).rejects.toThrow(/cookie/);
  });

  it("links are passed through as they are, with their own source and no search", async () => {
    const link = "https://soundcloud.com/a/mix";
    const a = scripted({ [link]: { out: sc } });
    expect(await createSource({ spawnFn: a.spawnFn }).resolve(link)).toMatchObject({ source: "soundcloud" });
    expect(a.calls[0]!.slice(-2)).toEqual(["--", link]);
    const file = "https://example.com/a.mp3";
    const b = scripted({ [file]: { out: { id: "a", title: "a.mp3", webpage_url: file } } });
    expect(await createSource({ spawnFn: b.spawnFn }).resolve(file)).toMatchObject({ source: "url", duration: 0 });
    const c = scripted({});
    await expect(createSource({ spawnFn: c.spawnFn }).resolve("http://127.0.0.1:8080/x")).rejects.toThrow(); // an internal address is a search, not fetched as a link
    expect(c.calls[0]!.at(-1)).toBe("ytsearch1:http://127.0.0.1:8080/x");
  });
});

describe("resolve cache", () => {
  it("a repeated search (any case or spacing) skips yt-dlp, returns the page but never an old stream URL; sc and plain searches are separate", async () => {
    const { spawnFn, calls } = scripted({ "ytsearch1:Lo Fi": { out: { ...yt } }, "scsearch1:Lo Fi": { out: sc } });
    const source = createSource({ spawnFn });
    const first = await source.resolve("Lo Fi");
    expect(first.direct).toBeDefined();
    const again = await source.resolve("  lo   FI ");
    expect(again).toMatchObject({ id: first.id, page: first.page, title: first.title });
    expect(again.direct).toBeUndefined();
    expect(calls).toHaveLength(1);
    await source.resolve("sc Lo Fi");
    expect(calls).toHaveLength(2);
  });

  it("a fallback result is remembered too, so the blocked source is not asked again for it", async () => {
    const { spawnFn, calls } = scripted({ "ytsearch1:x": { err: BOT_CHECK }, "scsearch1:x": { out: sc } });
    const source = createSource({ spawnFn });
    await source.resolve("x");
    await source.resolve("x");
    expect(calls).toHaveLength(2);
  });

  it("TtlLru: entries expire, the least recently used goes first when full, reading refreshes", () => {
    let now = 0;
    const lru = new TtlLru<number>(2, 100, () => now);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1); // a is now the freshest
    lru.set("c", 3); // b goes
    expect([lru.get("a"), lru.get("b"), lru.get("c")]).toEqual([1, undefined, 3]);
    now = 101;
    expect(lru.get("a")).toBeUndefined();
  });
});

describe("direct stream", () => {
  const withDirect = (age = 0): Track => ({ id: "dQw4w9WgXcQ", title: "t", duration: 1, source: "youtube", page: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", direct: { url: "https://rr1/a", headers: {}, at: Date.now() - age } });
  function openScript(ffOut: (ff: ReturnType<typeof fakeChild>) => void) {
    const procs: { bin: string; child: ReturnType<typeof fakeChild> }[] = [];
    const spawnFn = vi.fn((bin: string) => {
      const child = fakeChild();
      procs.push({ bin, child });
      if (bin === "ffmpeg") setImmediate(() => ffOut(child));
      return child;
    }) as any;
    return { procs, spawnFn };
  }

  it("a resolved track plays with ffmpeg alone: yt-dlp is not started", async () => {
    const { procs, spawnFn } = openScript((ff) => (ff.stdout.write(Buffer.from([7])), ff.stdout.end()));
    const out: Buffer[] = [];
    for await (const c of createSource({ spawnFn }).open(withDirect(), new AbortController().signal)) out.push(c);
    expect(out).toEqual([Buffer.from([7])]);
    expect(procs.map((p) => p.bin)).toEqual(["ffmpeg"]);
  });

  it("an old stream URL, or one ffmpeg cannot read, falls back to yt-dlp | ffmpeg", async () => {
    const old = openScript(() => {});
    const t1 = withDirect(DIRECT_TTL_MS + 1);
    const it1 = createSource({ spawnFn: old.spawnFn }).open(t1, new AbortController().signal)[Symbol.asyncIterator]();
    const first = it1.next();
    await new Promise((r) => setTimeout(r, 5));
    expect(old.procs.map((p) => p.bin)).toEqual(["yt-dlp", "ffmpeg"]);
    old.procs[1]!.child.stdout.write(Buffer.from([1]));
    expect((await first).value).toEqual(Buffer.from([1]));
    await it1.return!();

    const bad = openScript((ff) => ff.stdout.end()); // ffmpeg exits at once with no audio, for both attempts
    const t2 = withDirect();
    const drained = (async () => {
      for await (const _ of createSource({ spawnFn: bad.spawnFn }).open(t2, new AbortController().signal));
    })();
    await expect(drained).rejects.toThrow(); // the second attempt (yt-dlp | ffmpeg) also gave no audio
    expect(bad.procs.map((p) => p.bin)).toEqual(["ffmpeg", "yt-dlp", "ffmpeg"]);
    expect(t2.direct).toBeUndefined();
  });
});

describe("prefetch", () => {
  const queued: Track = { id: "dQw4w9WgXcQ", title: "t", duration: 1, source: "youtube", page: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };

  it("fills in the stream URL of a track that has only its page; a track that already has a fresh one costs nothing", async () => {
    const { spawnFn, calls } = scripted({ [queued.page]: { out: yt } });
    const source = createSource({ spawnFn });
    const t = { ...queued };
    await source.prefetch(t, new AbortController().signal);
    expect(t.direct?.url).toBe(stream.url);
    expect(calls[0]!.at(-1)).toBe(queued.page);
    await source.prefetch(t, new AbortController().signal);
    expect(calls).toHaveLength(1);
  });

  it("aborting kills yt-dlp and leaves the track untouched", async () => {
    const { spawnFn, children } = scripted({ [queued.page]: { hang: true } });
    const ctl = new AbortController();
    const t = { ...queued };
    const job = createSource({ spawnFn }).prefetch(t, ctl.signal);
    ctl.abort();
    await expect(job).rejects.toThrow();
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(t.direct).toBeUndefined();
  });
});
