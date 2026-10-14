import { parseUpdateStatus, canCheck, canInstall, type UpdateStatus } from "../shared/update";

export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The slice of electron-updater's `autoUpdater` we use (injected, and fetched lazily: never touched while updates are off; tests use a fake). */
export type AutoUpdater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Background updates: check shortly after start and every 6 h, download in the background, install when the app quits
 * (never a forced restart; `install()` is the user's explicit "restart now"). With `feedUrl` null nothing is wired and
 * no request is ever made. `download: false` (unsigned macOS apps cannot install an update by themselves) only reports
 * that a newer version exists; the user downloads it.
 */
export function createUpdater({ getAutoUpdater, feedUrl, send, download = true }: { getAutoUpdater: () => AutoUpdater; feedUrl: string | null; send: (s: UpdateStatus) => void; download?: boolean }) {
  let status: UpdateStatus = { state: feedUrl ? "idle" : "disabled" };
  const set = (next: unknown) => {
    status = parseUpdateStatus(next);
    send(status);
  };
  const fail = (e: unknown) => set({ state: "error", error: e instanceof Error ? e.message : String(e) });

  function check() {
    if (!feedUrl || !canCheck(status.state)) return;
    set({ state: "checking" });
    getAutoUpdater().checkForUpdates().catch(fail);
  }

  return {
    status: () => status,
    check,
    install() {
      if (canInstall(status.state)) getAutoUpdater().quitAndInstall();
    },
    /** Wires the feed and the schedule; the returned function stops the timers. */
    start() {
      if (!feedUrl) return () => {};
      const autoUpdater = getAutoUpdater();
      autoUpdater.autoDownload = download;
      autoUpdater.autoInstallOnAppQuit = download;
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
      autoUpdater.on("update-available", (info: { version?: string }) => set({ state: "available", version: info?.version }));
      autoUpdater.on("download-progress", () => status.state !== "downloading" && set({ state: "downloading", version: status.version }));
      autoUpdater.on("update-not-available", () => set({ state: "idle" }));
      autoUpdater.on("update-downloaded", (info: { version?: string }) => set({ state: "downloaded", version: info?.version }));
      autoUpdater.on("error", fail);
      const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
      const every = setInterval(check, CHECK_INTERVAL_MS);
      return () => (clearTimeout(first), clearInterval(every));
    },
  };
}
