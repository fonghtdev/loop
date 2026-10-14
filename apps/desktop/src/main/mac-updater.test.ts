import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_ERROR_APP_LOCATION, type UpdateStatus } from "../shared/update";
import { assetUrl, canReplaceApp, createMacUpdater, feedFileName, isNewer, MAX_ZIP_BYTES, parseFeed } from "./mac-updater";
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS } from "./updater";

const SHA = Buffer.alloc(64, 7).toString("base64");
const OTHER_SHA = Buffer.alloc(64, 9).toString("base64");

// The shape electron-builder writes (copied from the published 0.3.1 release, hashes replaced).
const feed = ({ version = "1.1.0", entries = [`  - url: Loop-${version}-arm64.zip\n    sha512: ${SHA}\n    size: 1000`], tail = `path: Loop-${version}-arm64.zip` }: { version?: string; entries?: string[]; tail?: string } = {}) =>
  [`version: ${version}`, "files:", ...entries, `  - url: Loop-${version}-arm64.dmg`, `    sha512: ${OTHER_SHA}`, "    size: 2000", tail, `sha512: ${SHA}`, "releaseDate: '2026-10-14T23:06:10.721Z'", ""].join("\n");

describe("parseFeed", () => {
  it("reads the zip entry for the arch (LF and CRLF)", () => {
    const want = { version: "1.1.0", name: "Loop-1.1.0-arm64.zip", sha512: SHA, size: 1000 };
    expect(parseFeed(feed(), "arm64")).toEqual(want);
    expect(parseFeed(feed().replace(/\n/g, "\r\n"), "arm64")).toEqual(want);
    const x64 = feed({ entries: [`  - url: Loop-1.1.0-x64.zip\n    sha512: ${SHA}\n    size: 1000`] });
    expect(parseFeed(x64, "x64").name).toBe("Loop-1.1.0-x64.zip");
  });

  it.each([
    ["the other arch's zip only", feed(), "x64", /expected exactly one Loop-1.1.0-x64.zip/],
    ["an unsupported arch", feed(), "ia32", /unsupported architecture/],
    ["a prefixed version", feed().replace("version: 1.1.0", "version: v1.1.0"), "arm64", /bad version/],
    ["a pre-release version", feed().replace("version: 1.1.0", "version: 1.1.0-beta.1"), "arm64", /bad version/],
    ["a quoted version", feed().replace("version: 1.1.0", "version: '1.1.0'"), "arm64", /bad version/],
    ["a two-part version", feed({ version: "1.1" }), "arm64", /bad version/],
    ["no version", feed().replace("version: 1.1.0\n", ""), "arm64", /bad version/],
    ["a short hash", feed().replace(`sha512: ${SHA}`, `sha512: ${Buffer.alloc(32).toString("base64")}`), "arm64", /bad sha512/],
    ["a hex hash", feed().replace(`sha512: ${SHA}`, `sha512: ${"ab".repeat(64)}`), "arm64", /bad sha512/],
    ["a hash with junk", feed().replace(`sha512: ${SHA}`, `sha512: ${SHA.slice(0, -3)}!==`), "arm64", /bad sha512/],
    ["size zero", feed().replace("size: 1000", "size: 0"), "arm64", /bad size/],
    ["size negative", feed().replace("size: 1000", "size: -5"), "arm64", /bad size/],
    ["size not a number", feed().replace("size: 1000", "size: 10e3"), "arm64", /bad size/],
    ["size above the cap", feed().replace("size: 1000", `size: ${MAX_ZIP_BYTES + 1}`), "arm64", /bad size/],
    ["no size", feed().replace("    size: 1000\n", ""), "arm64", /bad size/],
    ["the zip listed twice", feed({ entries: [`  - url: Loop-1.1.0-arm64.zip\n    sha512: ${SHA}\n    size: 1000`, `  - url: Loop-1.1.0-arm64.zip\n    sha512: ${OTHER_SHA}\n    size: 9`] }), "arm64", /exactly one/],
    ["a duplicate top-level key", `version: 9.9.9\n${feed()}`, "arm64", /duplicate version/],
    ["a duplicate key in an entry", feed().replace("    size: 1000", "    size: 1000\n    sha512: x"), "arm64", /duplicate sha512/],
    ["a tab-indented line", feed().replace("    size: 1000", "\tsize: 1000"), "arm64", /unexpected line/],
    ["a deeper nesting", feed().replace("    size: 1000", "    size: 1000\n      nested: 1"), "arm64", /unexpected line/],
    ["an entry outside files", `${feed()}  - url: x\n`, "arm64", /unexpected line/],
    ["only a traversal url", feed({ entries: [`  - url: ../Loop-1.1.0-arm64.zip\n    sha512: ${SHA}\n    size: 1000`] }), "arm64", /exactly one/],
    ["only an absolute url", feed({ entries: [`  - url: https://evil.example/Loop-1.1.0-arm64.zip\n    sha512: ${SHA}\n    size: 1000`] }), "arm64", /exactly one/],
  ])("rejects %s", (_n, text, arch, error) => {
    expect(() => parseFeed(text, arch)).toThrow(error);
  });

  it("ignores hostile url / path values next to the real entry: the name is always its own", () => {
    const text = feed({
      entries: [`  - url: https://evil.example/x.zip\n    sha512: ${OTHER_SHA}\n    size: 5`, `  - url: Loop-1.1.0-arm64.zip\n    sha512: ${SHA}\n    size: 1000`],
      tail: "path: ../../../etc/x",
    });
    expect(parseFeed(text, "arm64")).toEqual({ version: "1.1.0", name: "Loop-1.1.0-arm64.zip", sha512: SHA, size: 1000 });
  });
});

describe("helpers", () => {
  it.each([
    ["1.0.1", "1.0.0", true],
    ["1.10.0", "1.9.9", true],
    ["2.0.0", "1.99.99", true],
    ["1.0.0", "1.0.0", false],
    ["0.9.9", "1.0.0", false],
    ["1.0.0", "1.0.1", false],
    ["1.0.1-beta", "1.0.0", false],
    ["1.0.1", "junk", false],
  ])("isNewer(%s, %s) = %s", (a, b, want) => expect(isNewer(a, b)).toBe(want));

  it("reads the feed file of the running arch only", () => {
    expect([feedFileName("arm64"), feedFileName("x64"), feedFileName("ia32")]).toEqual(["latest-mac.yml", "latest-mac-x64.yml", null]);
  });

  it("builds URLs only from the feed folder + the name", () => {
    const base = "https://github.com/fonghtdev/loop/releases/latest/download";
    expect(assetUrl(base, "Loop-1.1.0-arm64.zip").href).toBe(`${base}/Loop-1.1.0-arm64.zip`);
    expect(assetUrl(`${base}/`, "latest-mac.yml").href).toBe(`${base}/latest-mac.yml`);
    // even a hostile name could not leave the folder or the origin
    expect(assetUrl(base, "../../x").href).toBe(`${base}/..%2F..%2Fx`);
    expect(assetUrl(base, "https://evil.example/x").origin).toBe("https://github.com");
  });

  it.each([
    ["/Applications/Loop.app", true, true],
    ["/Users/a/Applications/Loop.app", true, true],
    ["/private/var/folders/x/AppTranslocation/ABC/d/Loop.app", true, false],
    ["/Volumes/Loop 1.1.0/Loop.app", true, false],
    ["/Applications/Loop.app", false, false],
    [null, true, false],
  ])("canReplaceApp(%s, writable=%s) = %s", async (bundle, writable, want) => {
    expect(await canReplaceApp(bundle, async () => writable)).toBe(want);
  });

  it("needs the parent folder writable too (the swap renames the bundle)", async () => {
    expect(await canReplaceApp("/Applications/Loop.app", async (p) => p !== "/Applications")).toBe(false);
  });
});

/** A fake fetch serving fixed bodies by URL; records every request. */
function fakeNet(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("missing", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const FEED = "https://u.example.com/loop";

function updater(routes: Record<string, () => Response>, over: Partial<Parameters<typeof createMacUpdater>[0]> = {}) {
  const net = fakeNet(routes);
  const sent: UpdateStatus[] = [];
  const deps = {
    feedUrl: FEED,
    version: "1.0.0",
    arch: "arm64",
    execPath: "/Applications/Loop.app/Contents/MacOS/Loop",
    tempRoot: "/nonexistent-temp-root",
    pid: 1,
    send: (s: UpdateStatus) => void sent.push(s),
    quit: vi.fn(),
    spawnDetached: vi.fn(),
    fetch: net.fetchFn,
    writable: async () => true,
    ...over,
  };
  return { u: createMacUpdater(deps), deps, sent, calls: net.calls };
}

const yml = (text = feed()) => () => new Response(text);

describe("createMacUpdater: state machine", () => {
  it("without a feed: disabled, no timers, never fetches, never installs", async () => {
    vi.useFakeTimers();
    const { u, calls, deps } = updater({}, { feedUrl: null });
    u.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    vi.useRealTimers();
    await u.check();
    await u.install();
    expect(u.status()).toEqual({ state: "disabled" });
    expect(calls).toEqual([]);
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it("a check only reads the feed; nothing is downloaded before install() (the user's confirmation)", async () => {
    const { u, calls, sent, deps } = updater({ [`${FEED}/latest-mac.yml`]: yml() });
    await u.check();
    expect(u.status()).toEqual({ state: "available", version: "1.1.0" });
    expect(calls).toEqual([`${FEED}/latest-mac.yml`]);
    expect(sent.map((s) => s.state)).toEqual(["checking", "available"]);
    await u.check(); // no re-check while an update waits
    expect(calls).toHaveLength(1);
    expect(deps.spawnDetached).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it("Intel Macs read latest-mac-x64.yml", async () => {
    const x64 = feed({ entries: [`  - url: Loop-1.1.0-x64.zip\n    sha512: ${SHA}\n    size: 1000`] });
    const { u, calls } = updater({ [`${FEED}/latest-mac-x64.yml`]: yml(x64) }, { arch: "x64" });
    await u.check();
    expect(calls).toEqual([`${FEED}/latest-mac-x64.yml`]);
    expect(u.status()).toEqual({ state: "available", version: "1.1.0" });
  });

  it("same or older version: idle, and install() does nothing", async () => {
    const { u, calls } = updater({ [`${FEED}/latest-mac.yml`]: yml() }, { version: "1.1.0" });
    await u.check();
    expect(u.status()).toEqual({ state: "idle" });
    await u.install();
    expect(u.status()).toEqual({ state: "idle" });
    expect(calls).toHaveLength(1);
  });

  it("install() is ignored unless an update is available (idle, checking, error)", async () => {
    let release!: (r: Response) => void;
    let n = 0;
    const { u, calls, deps } = updater({
      [`${FEED}/latest-mac.yml`]: () => (++n === 1 ? new Response("bad feed") : (new Promise<Response>((r) => (release = r)) as unknown as Response)),
    });
    await u.install(); // idle
    await u.check();
    expect(u.status().state).toBe("error");
    await u.install(); // error
    const checking = u.check();
    await u.install(); // checking
    expect(u.status().state).toBe("checking");
    release(new Response(feed()));
    await checking;
    expect(u.status().state).toBe("available");
    expect(calls).toEqual([`${FEED}/latest-mac.yml`, `${FEED}/latest-mac.yml`]);
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it("a second install() while the first is under way does nothing (one download only)", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "loop-mu-unit-"));
    try {
      const { u, calls } = updater({ [`${FEED}/latest-mac.yml`]: yml(), [`${FEED}/Loop-1.1.0-arm64.zip`]: () => new Response("gone", { status: 410 }) }, { tempRoot });
      await u.check();
      await Promise.all([u.install(), u.install()]);
      expect(calls.filter((c) => c.endsWith(".zip"))).toHaveLength(1);
      expect(u.status()).toEqual({ state: "error", error: "HTTP 410" });
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("an app that cannot be replaced (translocated, read-only, not writable): clear error, no download, and a later check still works", async () => {
    for (const over of [
      { execPath: "/private/var/folders/x/T/AppTranslocation/ABCD/d/Loop.app/Contents/MacOS/Loop" },
      { execPath: "/Volumes/Loop/Loop.app/Contents/MacOS/Loop" },
      { writable: async () => false },
      { execPath: "/usr/local/bin/loop" },
    ]) {
      const { u, calls, deps } = updater({ [`${FEED}/latest-mac.yml`]: yml() }, over);
      await u.check();
      await u.install();
      expect(u.status()).toEqual({ state: "error", error: UPDATE_ERROR_APP_LOCATION });
      expect(calls).toEqual([`${FEED}/latest-mac.yml`]);
      expect(deps.spawnDetached).not.toHaveBeenCalled();
      expect(deps.quit).not.toHaveBeenCalled();
      await u.check();
      expect(u.status().state).toBe("available");
    }
  });

  it("errors (HTTP, network, bad feed) end in `error`, and the next check is allowed", async () => {
    let n = 0;
    const { u } = updater({
      [`${FEED}/latest-mac.yml`]: () => {
        n++;
        if (n === 1) return new Response("no", { status: 500 });
        if (n === 2) throw new TypeError("fetch failed");
        return n === 3 ? new Response("version: x") : new Response(feed());
      },
    });
    await u.check();
    expect(u.status()).toEqual({ state: "error", error: "HTTP 500" });
    await u.check();
    expect(u.status()).toEqual({ state: "error", error: "fetch failed" });
    await u.check();
    expect(u.status()).toEqual({ state: "error", error: "update feed: bad version" });
    await u.check();
    expect(u.status().state).toBe("available");
  });

  it("follows https redirects, refuses any hop that is not https (production default), and limits the hops", async () => {
    const to = (location: string) => () => new Response(null, { status: 302, headers: { location } });
    const ok = updater({ [`${FEED}/latest-mac.yml`]: to("https://cdn.example.net/f.yml"), "https://cdn.example.net/f.yml": yml() });
    await ok.u.check();
    expect(ok.u.status().state).toBe("available");
    expect(ok.calls).toEqual([`${FEED}/latest-mac.yml`, "https://cdn.example.net/f.yml"]);

    const down = updater({ [`${FEED}/latest-mac.yml`]: to("http://cdn.example.net/f.yml"), "http://cdn.example.net/f.yml": yml() });
    await down.u.check();
    expect(down.u.status()).toEqual({ state: "error", error: "refused to fetch http://cdn.example.net" });
    expect(down.calls).toEqual([`${FEED}/latest-mac.yml`]);

    const loop = updater({ [`${FEED}/latest-mac.yml`]: to(`${FEED}/latest-mac.yml`) });
    await loop.u.check();
    expect(loop.u.status()).toEqual({ state: "error", error: "too many redirects" });

    const http = updater({}, { feedUrl: "http://u.example.com/loop" });
    await http.u.check();
    expect(http.u.status()).toEqual({ state: "error", error: "refused to fetch http://u.example.com" });
    expect(http.calls).toEqual([]);
  });

  it("refuses an oversized feed", async () => {
    const { u } = updater({ [`${FEED}/latest-mac.yml`]: yml(`${feed()}${"#".repeat(70_000)}`) });
    await u.check();
    expect(u.status()).toEqual({ state: "error", error: "download larger than announced" });
  });

  describe("schedule", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    it("first check after 30 s, then every 6 h; stop() ends it", async () => {
      const { u, calls } = updater({ [`${FEED}/latest-mac.yml`]: yml(feed({ version: "1.0.0" })) });
      const stop = u.start();
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
      expect(calls).toHaveLength(1);
      expect(u.status()).toEqual({ state: "idle" });
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(calls).toHaveLength(2);
      stop();
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
      expect(calls).toHaveLength(2);
    });
  });
});
