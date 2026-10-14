import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { access, chmod, constants, lstat, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { APP_ID } from "../shared/app-id";
import { canCheck, parseUpdateStatus, UPDATE_ERROR_APP_LOCATION, type UpdateStatus } from "../shared/update";
import { bundlePathFromExe } from "./uninstall";
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS } from "./updater";

/*
 * macOS updates without a code signature (Squirrel.Mac refuses unsigned updates): read the electron-builder feed,
 * and only after the user confirmed, download the zip, check its SHA-512 against the feed, unzip it, check the bundle,
 * then a detached /bin/sh helper swaps the bundle once this process has exited and opens the new one (restoring the old
 * one if any step fails). Integrity rests on HTTPS + the SHA-512 published in the same GitHub release.
 */

export const MAX_ZIP_BYTES = 400 * 1024 * 1024;
const MAX_FEED_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const FEED_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

export type FeedEntry = { version: string; name: string; sha512: string; size: number };

/** arm64 reads electron-builder's own name; the release workflow renames the Intel build's copy (two builds, one folder). */
export const feedFileName = (arch: string) => (arch === "arm64" ? "latest-mac.yml" : arch === "x64" ? "latest-mac-x64.yml" : null);
export const zipName = (version: string, arch: string) => `Loop-${version}-${arch}.zip`;
/** The ONLY way a download URL is made: the feed folder + a name this module built itself (never a `url:`/`path:` from the feed). */
export const assetUrl = (feedUrl: string, name: string) => new URL(`${feedUrl.replace(/\/+$/, "")}/${encodeURIComponent(name)}`);

/**
 * Strict reader for electron-builder's latest-mac.yml (top-level `key: value`, a `files:` list of `- url:` / `sha512:` /
 * `size:` maps). Anything else in the grammar, a duplicate key, or a bad value for the entry we use throws.
 */
export function parseFeed(text: string, arch: string): FeedEntry {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`unsupported architecture ${arch}`);
  const top = new Map<string, string>();
  const files: Map<string, string>[] = [];
  let inFiles = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    let m: RegExpExecArray | null;
    if ((m = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line))) {
      setOnce(top, m[1], m[2] ?? "");
      inFiles = m[1] === "files" && !m[2];
    } else if (inFiles && (m = /^ {2}- ([A-Za-z][A-Za-z0-9]*): (.+)$/.exec(line))) {
      files.push(new Map());
      setOnce(files[files.length - 1], m[1], m[2]);
    } else if (inFiles && files.length > 0 && (m = /^ {4}([A-Za-z][A-Za-z0-9]*): (.+)$/.exec(line))) {
      setOnce(files[files.length - 1], m[1], m[2]);
    } else {
      throw new Error("update feed: unexpected line");
    }
  }
  const version = top.get("version") ?? "";
  if (!VERSION.test(version)) throw new Error("update feed: bad version");
  const name = zipName(version, arch);
  const matches = files.filter((f) => f.get("url") === name);
  if (matches.length !== 1) throw new Error(`update feed: expected exactly one ${name}`);
  const sha512 = matches[0].get("sha512") ?? "";
  if (!SHA512_BASE64.test(sha512) || Buffer.from(sha512, "base64").length !== 64) throw new Error("update feed: bad sha512");
  const sizeText = matches[0].get("size") ?? "";
  const size = /^[1-9]\d{0,9}$/.test(sizeText) ? Number(sizeText) : 0;
  if (!size || size > MAX_ZIP_BYTES) throw new Error("update feed: bad size");
  return { version, name, sha512, size };
}

function setOnce(map: Map<string, string>, key: string, value: string) {
  if (map.has(key)) throw new Error(`update feed: duplicate ${key}`);
  map.set(key, value);
}

/** Strict semver (X.Y.Z only) comparison: is `a` newer than `b`? */
export function isNewer(a: string, b: string): boolean {
  if (!VERSION.test(a) || !VERSION.test(b)) return false;
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Whether the running bundle can be swapped: not translocated, not on a mounted disk image, writable along with its folder. */
export async function canReplaceApp(bundle: string | null, writable: (path: string) => Promise<boolean>): Promise<boolean> {
  if (!bundle || bundle.includes("/AppTranslocation/") || bundle.startsWith("/Volumes/")) return false;
  return (await writable(bundle)) && (await writable(dirname(bundle)));
}

const isWritable = (path: string) => access(path, constants.W_OK).then(() => true, () => false);

/**
 * Runs detached after the app quits. Every value is a positional argument, never part of the script text:
 * $1 pid to wait for, $2 installed bundle, $3 verified new bundle, $4 backup path, $5 log file, $6 open command, $7 temp dir.
 */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; app="$2"; new="$3"; backup="$4"; log="$5"; open="$6"; tmp="$7"
say() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >>"$log"; }
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then say "app still running after 30 s, nothing changed"; exit 1; fi
  sleep 0.1
done
restore() {
  say "failed: $1, restoring the previous version"
  rm -rf -- "$app"
  mv -- "$backup" "$app" || say "restore failed, previous version kept at $backup"
  "$open" "$app"
  exit 1
}
if ! mv -- "$app" "$backup"; then say "cannot move the installed app"; "$open" "$app"; exit 1; fi
mv -- "$new" "$app" || restore "move new version"
/usr/bin/xattr -cr "$app" || restore "xattr"
"$open" "$app" || restore "open"
rm -rf -- "$backup" "$tmp"
`;

export type MacUpdaterDeps = {
  /** The feed folder; null = disabled (no network at all). Production passes only an https URL (updatesEnabled). */
  feedUrl: string | null;
  version: string;
  arch: string;
  execPath: string;
  tempRoot: string;
  pid: number;
  send: (s: UpdateStatus) => void;
  quit: () => void;
  spawnDetached: (cmd: string, args: string[]) => void;
  fetch?: typeof fetch;
  /** Every URL fetched, redirects included, must pass this. Production: https only; tests widen it to a loopback server. */
  allowUrl?: (url: URL) => boolean;
  run?: (cmd: string, args: string[]) => Promise<string>;
  writable?: (path: string) => Promise<boolean>;
  openCommand?: string;
};

const runFile = promisify(execFile);
const defaultRun = async (cmd: string, args: string[]) => (await runFile(cmd, args)).stdout;
const httpsOnly = (url: URL) => url.protocol === "https:";

export function createMacUpdater(d: MacUpdaterDeps) {
  const fetchFn = d.fetch ?? fetch;
  const allowUrl = d.allowUrl ?? httpsOnly;
  const run = d.run ?? defaultRun;
  let status: UpdateStatus = { state: d.feedUrl ? "idle" : "disabled" };
  let pending: FeedEntry | null = null;
  const set = (next: unknown) => {
    status = parseUpdateStatus(next);
    d.send(status);
  };
  const fail = (e: unknown) => {
    pending = null;
    set({ state: "error", error: e instanceof Error ? e.message : String(e) });
  };

  /** GET with redirects followed by hand, so every hop is checked by `allowUrl` (GitHub sends assets to another host). */
  async function get(start: URL, signal: AbortSignal): Promise<Response> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!allowUrl(url)) throw new Error(`refused to fetch ${url.protocol}//${url.host}`);
      const res = await fetchFn(url, { redirect: "manual", signal });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (res.ok) return res;
      await res.body?.cancel();
      if (!location) throw new Error(`HTTP ${res.status}`);
      url = new URL(location, url);
    }
    throw new Error("too many redirects");
  }

  /** Streams the body to `onChunk`, refusing (and dropping the connection) as soon as it exceeds `max` bytes. */
  async function readBody(res: Response, max: number, onChunk: (chunk: Uint8Array, total: number) => Promise<void> | void): Promise<number> {
    if (Number(res.headers.get("content-length")) > max || !res.body) throw new Error(res.body ? "download larger than announced" : "empty response");
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > max) throw new Error("download larger than announced");
      await onChunk(chunk, total);
    }
    return total;
  }

  async function check() {
    if (!d.feedUrl || !canCheck(status.state)) return;
    set({ state: "checking" });
    try {
      const file = feedFileName(d.arch);
      if (!file) throw new Error(`unsupported architecture ${d.arch}`);
      const res = await get(assetUrl(d.feedUrl, file), AbortSignal.timeout(FEED_TIMEOUT_MS));
      const chunks: Uint8Array[] = [];
      await readBody(res, MAX_FEED_BYTES, (c) => void chunks.push(c));
      const entry = parseFeed(Buffer.concat(chunks).toString("utf8"), d.arch);
      pending = isNewer(entry.version, d.version) ? entry : null;
      set(pending ? { state: "available", version: entry.version } : { state: "idle" });
    } catch (e) {
      fail(e);
    }
  }

  async function download(entry: FeedEntry, dir: string): Promise<string> {
    const res = await get(assetUrl(d.feedUrl!, entry.name), AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
    const zip = join(dir, entry.name);
    const file = await open(zip, "wx", 0o600);
    const hash = createHash("sha512");
    let percent = 0;
    try {
      const total = await readBody(res, entry.size, async (chunk, received) => {
        hash.update(chunk);
        await file.write(chunk);
        const now = Math.floor((received * 100) / entry.size);
        if (now !== percent) set({ state: "downloading", version: entry.version, percent: (percent = now) });
      });
      if (total !== entry.size) throw new Error("download smaller than announced");
    } finally {
      await file.close();
    }
    if (!timingSafeEqual(hash.digest(), Buffer.from(entry.sha512, "base64"))) throw new Error("checksum mismatch");
    return zip;
  }

  /** Unzips with ditto and checks the result is one Loop.app of the expected id and version, with its executable. */
  async function extract(zip: string, dir: string, version: string): Promise<string> {
    const out = join(dir, "new");
    await mkdir(out, { mode: 0o700 });
    await run("/usr/bin/ditto", ["-x", "-k", zip, out]);
    await rm(zip, { force: true });
    const entries = await readdir(out);
    if (entries.length !== 1 || entries[0] !== "Loop.app") throw new Error("unexpected archive content");
    const bundle = join(out, "Loop.app");
    if (!(await lstat(bundle)).isDirectory()) throw new Error("unexpected archive content");
    const plist = join(bundle, "Contents", "Info.plist");
    const read = async (key: string) => (await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist])).trim();
    if ((await read("CFBundleIdentifier")) !== APP_ID) throw new Error("wrong bundle identifier");
    if ((await read("CFBundleShortVersionString")) !== version) throw new Error("wrong bundle version");
    const exe = await lstat(join(bundle, "Contents", "MacOS", "Loop"));
    if (!exe.isFile() || !(exe.mode & 0o111)) throw new Error("bundle has no executable");
    return bundle;
  }

  /** Only after the user confirmed (the IPC handler), and only for the version the last check found. */
  async function install() {
    const entry = pending;
    if (status.state !== "available" || !entry || !d.feedUrl) return;
    set({ state: "downloading", version: entry.version, percent: 0 });
    let dir: string | null = null;
    try {
      const installed = bundlePathFromExe(d.execPath);
      if (!installed || !(await canReplaceApp(installed, d.writable ?? isWritable))) throw new Error(UPDATE_ERROR_APP_LOCATION);
      dir = await mkdtemp(join(d.tempRoot, "loop-update-"));
      await chmod(dir, 0o700);
      const fresh = await extract(await download(entry, dir), dir, entry.version);
      set({ state: "installing", version: entry.version });
      // Same volume: the backup is a cheap rename into the temp dir; otherwise it stays next to the app.
      const sameVolume = (await stat(dir)).dev === (await stat(dirname(installed))).dev;
      const backup = sameVolume ? join(dir, "Loop.old.app") : `${installed}.old-${randomBytes(4).toString("hex")}`;
      const script = join(dir, "swap.sh");
      await writeFile(script, SWAP_SCRIPT, { mode: 0o700, flag: "wx" });
      d.spawnDetached("/bin/sh", [script, String(d.pid), installed, fresh, backup, join(dir, "swap.log"), d.openCommand ?? "/usr/bin/open", dir]);
      d.quit();
    } catch (e) {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      fail(e);
    }
  }

  return {
    status: () => status,
    check,
    install,
    /** The same schedule as the other platforms; the returned function stops the timers. */
    start() {
      if (!d.feedUrl) return () => {};
      const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
      const every = setInterval(check, CHECK_INTERVAL_MS);
      return () => (clearTimeout(first), clearInterval(every));
    },
  };
}
