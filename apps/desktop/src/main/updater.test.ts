import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canCheck, canInstall, parseUpdateStatus, UPDATE_STATES, updatesEnabled, type UpdateStatus } from "../shared/update";
import { CHECK_INTERVAL_MS, createUpdater, FIRST_CHECK_DELAY_MS } from "./updater";

describe("updatesEnabled", () => {
  it.each([
    ["packaged + https feed", true, "https://updates.example.com/loop", true],
    ["not packaged (dev, e2e of the unpacked app)", false, "https://updates.example.com/loop", false],
    ["packaged, no feed baked", true, "", false],
    ["packaged, http feed", true, "http://updates.example.com/loop", false],
    ["packaged, junk feed", true, "not a url", false],
    ["packaged, file feed", true, "file:///tmp/feed", false],
  ])("%s", (_n, isPackaged, feedUrl, expected) => {
    expect(updatesEnabled({ isPackaged, feedUrl })).toBe(expected);
  });
});

describe("state guards", () => {
  it("checks only when idle or after an error; installs only once downloaded", () => {
    expect(UPDATE_STATES.filter(canCheck)).toEqual(["idle", "error"]);
    expect(UPDATE_STATES.filter(canInstall)).toEqual(["downloaded"]);
  });
});

describe("parseUpdateStatus", () => {
  it("keeps known states, caps the strings, falls back to error for junk", () => {
    expect(parseUpdateStatus({ state: "downloaded", version: "1.2.3", extra: 1 })).toEqual({ state: "downloaded", version: "1.2.3" });
    expect(parseUpdateStatus({ state: "error", error: `a\n${"x".repeat(500)}` }).error).toHaveLength(200);
    expect(parseUpdateStatus({ state: "error", error: `a\n  b` }).error).toBe("a b");
    expect(parseUpdateStatus({ state: "hacked" }).state).toBe("error");
    expect(parseUpdateStatus(null).state).toBe("error");
    expect(parseUpdateStatus({ state: "idle", version: "9".repeat(300) }).version).toHaveLength(64);
  });
});

function fake() {
  const handlers = new Map<string, (...a: any[]) => void>();
  const au = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: (e: string, h: (...a: any[]) => void) => void handlers.set(e, h),
  };
  const sent: UpdateStatus[] = [];
  const emit = (e: string, ...a: unknown[]) => handlers.get(e)!(...a);
  return { au, sent, emit, send: (s: UpdateStatus) => void sent.push(s) };
}

describe("createUpdater", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("without a feed: disabled, wires nothing, never checks, never installs", () => {
    const f = fake();
    const u = createUpdater({ getAutoUpdater: () => f.au, feedUrl: null, send: f.send });
    const stop = u.start();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);
    u.check();
    u.install();
    stop();
    expect(u.status()).toEqual({ state: "disabled" });
    expect(f.au.setFeedURL).not.toHaveBeenCalled();
    expect(f.au.checkForUpdates).not.toHaveBeenCalled();
    expect(f.au.quitAndInstall).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it("with a feed: background download + install on quit, first check after a delay, then every 6 h", () => {
    const f = fake();
    const u = createUpdater({ getAutoUpdater: () => f.au, feedUrl: "https://u.example.com/loop", send: f.send });
    const stop = u.start();
    expect(f.au).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true });
    expect(f.au.setFeedURL).toHaveBeenCalledWith({ provider: "generic", url: "https://u.example.com/loop" });
    expect(f.au.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS);
    expect(f.au.checkForUpdates).toHaveBeenCalledTimes(1);
    f.emit("update-not-available");
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(f.au.checkForUpdates).toHaveBeenCalledTimes(2);
    stop();
    f.emit("update-not-available");
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);
    expect(f.au.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("walks idle > checking > available > downloading > downloaded; install only then, and never starts a check meanwhile", () => {
    const f = fake();
    const u = createUpdater({ getAutoUpdater: () => f.au, feedUrl: "https://u.example.com/loop", send: f.send });
    u.start();
    u.install();
    expect(f.au.quitAndInstall).not.toHaveBeenCalled(); // idle
    u.check();
    u.check(); // already checking
    expect(f.au.checkForUpdates).toHaveBeenCalledTimes(1);
    f.emit("update-available", { version: "1.1.0" });
    f.emit("download-progress", { percent: 5 });
    f.emit("download-progress", { percent: 6 });
    u.check();
    u.install();
    expect(f.au.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(f.au.quitAndInstall).not.toHaveBeenCalled();
    f.emit("update-downloaded", { version: "1.1.0" });
    u.check();
    expect(f.au.checkForUpdates).toHaveBeenCalledTimes(1);
    u.install();
    expect(f.au.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(f.sent.map((s) => s.state)).toEqual(["checking", "available", "downloading", "downloaded"]);
    expect(u.status()).toEqual({ state: "downloaded", version: "1.1.0" });
  });

  it("an error (event or rejected check) is shown short, and the next check is allowed", async () => {
    const f = fake();
    f.au.checkForUpdates.mockRejectedValueOnce(new Error("net::ERR " + "x".repeat(400)));
    const u = createUpdater({ getAutoUpdater: () => f.au, feedUrl: "https://u.example.com/loop", send: f.send });
    u.start();
    u.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(u.status().state).toBe("error");
    expect(u.status().error).toHaveLength(200);
    u.check();
    expect(f.au.checkForUpdates).toHaveBeenCalledTimes(2);
    f.emit("error", new Error("boom"));
    expect(u.status()).toEqual({ state: "error", error: "boom" });
  });
});
