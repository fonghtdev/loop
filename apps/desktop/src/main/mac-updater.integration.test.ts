import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../shared/update";
import { createMacUpdater } from "./mac-updater";

/*
 * The real thing on macOS: a loopback HTTP feed, a zip made by ditto from a fake Loop.app, a fake installed bundle in a
 * temp dir, the real /bin/sh swap helper (detached), ditto, plutil and xattr. Only `open` is replaced (it appends the
 * path it was asked to open to a log) and the "running app" is a short-lived child process.
 */

let root: string;
let server: Server;
let routes: Map<string, Buffer>;
let base: string;

function fakeBundle(dir: string, { id = "app.loop.desktop", version, marker }: { id?: string; version: string; marker: string }) {
  const app = join(dir, "Loop.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`,
  );
  writeFileSync(join(app, "Contents", "MacOS", "Loop"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(app, "Contents", "MacOS", "Loop"), 0o755);
  writeFileSync(join(app, "Contents", "Resources", "marker"), marker);
  return app;
}

/** Zips a fresh fake bundle the way the release does (ditto --keepParent) and returns the zip bytes. */
function zipOf(opts: { id?: string; version: string; marker: string }) {
  const dir = mkdtempSync(join(root, "build-"));
  const app = fakeBundle(dir, opts);
  const zip = join(dir, "out.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  return readFileSync(zip);
}

const feedFor = (zip: Buffer, { version = "1.1.0", size = zip.length, sha512 = createHash("sha512").update(zip).digest("base64") } = {}) =>
  Buffer.from(`version: ${version}\nfiles:\n  - url: Loop-${version}-arm64.zip\n    sha512: ${sha512}\n    size: ${size}\npath: Loop-${version}-arm64.zip\nsha512: ${sha512}\nreleaseDate: '2026-10-15T00:00:00.000Z'\n`);

function publish(zip: Buffer, feedOpts?: Parameters<typeof feedFor>[1], served = zip) {
  routes.set("/cdn/latest-mac.yml", feedFor(zip, feedOpts));
  routes.set(`/feed/Loop-${feedOpts?.version ?? "1.1.0"}-arm64.zip`, served);
}

async function until(cond: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function setup({ failFirstOpen = false } = {}) {
  const apps = join(root, "Applications");
  const installed = fakeBundle(apps, { version: "1.0.0", marker: "old" });
  const tempRoot = join(root, "tmp");
  mkdirSync(tempRoot);
  const opened = join(root, "opened.log");
  const open = join(root, "open.sh");
  // A stand-in for /usr/bin/open: logs its argument; optionally fails the first time (a failing swap step).
  writeFileSync(open, `#!/bin/sh\nfirst=0; [ -e "${opened}" ] || first=1\necho "$1" >>"${opened}"\n${failFirstOpen ? '[ "$first" = 1 ] && exit 1\n' : ""}exit 0\n`);
  chmodSync(open, 0o755);
  const running = spawn("/bin/sleep", ["0.5"]); // "the app": the helper waits for this pid to exit
  const sent: UpdateStatus[] = [];
  const quit = vi.fn();
  const spawnDetached = vi.fn((cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: "ignore" }).unref());
  const u = createMacUpdater({
    feedUrl: `${base}/feed`,
    allowUrl: (url) => url.protocol === "http:" && url.hostname === "127.0.0.1", // test only: production is https-only
    version: "1.0.0",
    arch: "arm64",
    execPath: join(installed, "Contents", "MacOS", "Loop"),
    tempRoot,
    pid: running.pid!,
    send: (s) => void sent.push(s),
    quit,
    spawnDetached,
    openCommand: open,
  });
  const marker = () => readFileSync(join(installed, "Contents", "Resources", "marker"), "utf8");
  return { u, installed, apps, tempRoot, opened, sent, quit, spawnDetached, marker };
}

describe.runIf(process.platform === "darwin")("mac updater on this Mac (loopback feed, real ditto/plutil/sh)", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "loop-mac-updater-"));
    routes = new Map();
    server = createServer((req, res) => {
      if (req.url === "/feed/latest-mac.yml") return void res.writeHead(302, { location: "/cdn/latest-mac.yml" }).end(); // like GitHub's redirect
      const body = routes.get(req.url ?? "");
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200); // chunked, no content-length: the size limit must hold while streaming
      for (let i = 0; i < body.length; i += 4096) res.write(body.subarray(i, i + 4096));
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  it("happy path: verifies, swaps the bundle after the app exits, opens the new one, leaves nothing behind", async () => {
    const t = setup();
    publish(zipOf({ version: "1.1.0", marker: "new" }));
    await t.u.check();
    expect(t.u.status()).toEqual({ state: "available", version: "1.1.0" });
    expect(t.spawnDetached).not.toHaveBeenCalled();
    await t.u.install();
    expect(t.u.status()).toEqual({ state: "installing", version: "1.1.0" });
    expect(t.sent.some((s) => s.state === "downloading" && s.percent === 100)).toBe(true);
    expect(t.quit).toHaveBeenCalledTimes(1);
    await until(() => existsSync(t.opened) && readdirSync(t.tempRoot).length === 0);
    expect(t.marker()).toBe("new");
    expect(execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(t.installed, "Contents", "Info.plist")], { encoding: "utf8" }).trim()).toBe("1.1.0");
    expect(readFileSync(t.opened, "utf8")).toBe(`${t.installed}\n`);
    expect(readdirSync(t.apps)).toEqual(["Loop.app"]);
  });

  it("a flipped byte (hash mismatch): error, old bundle untouched, no temp leftovers, nothing spawned", async () => {
    const t = setup();
    const zip = zipOf({ version: "1.1.0", marker: "new" });
    const evil = Buffer.from(zip);
    evil[evil.length >> 1] ^= 0xff;
    publish(zip, {}, evil);
    await t.u.check();
    await t.u.install();
    expect(t.u.status()).toEqual({ state: "error", error: "checksum mismatch" });
    expect(t.marker()).toBe("old");
    expect(readdirSync(t.tempRoot)).toEqual([]);
    expect(t.spawnDetached).not.toHaveBeenCalled();
    expect(t.quit).not.toHaveBeenCalled();
    await t.u.check(); // recoverable
    expect(t.u.status().state).toBe("available");
  });

  it.each([
    ["a wrong bundle identifier", { id: "com.example.evil", version: "1.1.0", marker: "new" }, "wrong bundle identifier"],
    ["a bundle version other than the feed's", { version: "1.2.0", marker: "new" }, "wrong bundle version"],
  ])("refuses %s (hash matches): old bundle untouched, cleaned up", async (_n, bundle, error) => {
    const t = setup();
    publish(zipOf(bundle));
    await t.u.check();
    await t.u.install();
    expect(t.u.status()).toEqual({ state: "error", error });
    expect(t.marker()).toBe("old");
    expect(readdirSync(t.tempRoot)).toEqual([]);
    expect(t.spawnDetached).not.toHaveBeenCalled();
  });

  it("an oversized body is cut off at the announced size", async () => {
    const t = setup();
    const zip = zipOf({ version: "1.1.0", marker: "new" });
    publish(zip, { size: zip.length - 100 });
    await t.u.check();
    await t.u.install();
    expect(t.u.status()).toEqual({ state: "error", error: "download larger than announced" });
    expect(t.marker()).toBe("old");
    expect(readdirSync(t.tempRoot)).toEqual([]);
  });

  it("a failing swap step (relaunch fails) restores and reopens the original bundle", async () => {
    const t = setup({ failFirstOpen: true });
    publish(zipOf({ version: "1.1.0", marker: "new" }));
    await t.u.check();
    await t.u.install();
    expect(t.quit).toHaveBeenCalledTimes(1);
    await until(() => existsSync(t.opened) && readFileSync(t.opened, "utf8").split("\n").length === 3);
    expect(t.marker()).toBe("old");
    expect(readdirSync(t.apps)).toEqual(["Loop.app"]);
    const [dir] = readdirSync(t.tempRoot); // kept for its log
    expect(readFileSync(join(t.tempRoot, dir, "swap.log"), "utf8")).toMatch(/failed: open, restoring the previous version/);
  });
});
