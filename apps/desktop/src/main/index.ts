import { tmpdir } from "node:os";
import { appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, net, Notification, powerMonitor, protocol, safeStorage, session, shell, systemPreferences, type IpcMainInvokeEvent } from "electron";
import { APP_ID } from "../shared/app-id";
import { API_URL, LIVEKIT_ORIGIN, STORAGE_ORIGIN, UPDATE_URL, WS_URL } from "../shared/config";
import type { Settings } from "../shared/settings";
import { updatesEnabled, type UpdateStatus } from "../shared/update";
import { APP_ORIGIN, buildCsp, ensureMediaAccess, isMediaKind, isPermissionAllowed, isSafeExternalUrl, isTrustedSender, isValidRefreshToken, resolveAppFile } from "./security";
import { installE2eHook, newRecorder } from "./e2e-hook";
import { createIdleWatch } from "./idle";
import { loadKeyHook } from "./key-hook";
import { createNotifier } from "./notifications";
import { loginItemSettings, normalizeBadge, revealWindow, shouldHideOnClose, startsHidden, windowIsFocused } from "./policy";
import { createPtt } from "./ptt";
import { createScreenShare } from "./screen";
import { createSettingsStore } from "./settings";
import { createShortcuts } from "./shortcuts";
import { createTokenStore } from "./token-store";
import { createTray, type TrayHandle } from "./tray";
import { createMacUpdater } from "./mac-updater";
import { createUpdater } from "./updater";
import { runUninstall } from "./uninstall";

// Set by electron-vite in dev only; production loads the built renderer from app://loop.
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const rendererDir = join(__dirname, "../renderer");
const csp = buildCsp({ api: API_URL, ws: WS_URL, storage: STORAGE_ORIGIN, livekit: LIVEKIT_ORIGIN }, devServerUrl);

// Test/dev hook: a separate profile (the E2E smoke test relaunches against the same one).
if (process.env.LOOP_USER_DATA_DIR) app.setPath("userData", process.env.LOOP_USER_DATA_DIR);

// Windows needs an app id for notifications to show (and group) under the app's name; the installer's appId is the same (a test keeps them equal).
app.setAppUserModelId(APP_ID);

// Test hook (see e2e-hook.ts): off unless LOOP_E2E=1.
const e2e = process.env.LOOP_E2E === "1";
const recorder = e2e ? newRecorder() : undefined;

let win: BrowserWindow | null = null;
let tray: TrayHandle | null = null;
let quitting = false; // a real quit is under way: closing windows must not be intercepted
let focusOverride: boolean | null = null; // e2e only
let uninstallAnswer = false; // e2e only: stands in for the click on the native confirmation
const screenShare = createScreenShare({ getSources: (o) => desktopCapturer.getSources(o), trusted: (url) => isTrustedSender(url, devServerUrl), platform: process.platform });
let settings: ReturnType<typeof createSettingsStore>;
const shortcuts = createShortcuts({ globalShortcut, onPress: (action) => win?.webContents.send("shortcut:fire", action) });
const ptt = createPtt({
  loadHook: loadKeyHook,
  send: (held) => win && !win.isDestroyed() && win.webContents.send("ptt:held", held),
  // macOS lists keyboard listening under Accessibility / Input Monitoring; the prompt appears once, when push-to-talk first starts in a room
  permitted: (prompt) => process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(prompt),
  platform: process.platform,
});
let updater: Pick<ReturnType<typeof createUpdater>, "status" | "check" | "install" | "start">;

// A standard + secure scheme gives the renderer a real origin (app://loop) for CORS, unlike file://.
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function serveRenderer() {
  protocol.handle("app", async (request) => {
    const file = resolveAppFile(rendererDir, request.url);
    if (!file) return new Response("Not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set("Content-Security-Policy", csp);
    return new Response(res.body, { status: res.status, headers });
  });
}

function registerIpc() {
  // Linux without a keyring falls back to a hard-coded key: treat that as "no encryption".
  const store = createTokenStore(join(app.getPath("userData"), "session.bin"), {
    isEncryptionAvailable: () =>
      safeStorage.isEncryptionAvailable() &&
      !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b),
  });
  settings = createSettingsStore(join(app.getPath("userData"), "settings.json"));
  const notifier = createNotifier({
    Notification,
    settings: () => settings.get(),
    onClick: (key) => {
      showWindow();
      win?.webContents.send("notification:navigate", key);
    },
    record: recorder,
  });
  if (e2e) hookE2e();
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event.senderFrame?.url ?? "", devServerUrl)) throw new Error("untrusted sender");
      return fn(...args);
    });

  handle("session:get", () => ({ token: store.get(), persistent: store.persistent }));
  handle("session:set", (token) => {
    if (!isValidRefreshToken(token)) throw new Error("invalid token");
    store.set(token);
  });
  handle("session:clear", () => store.clear());
  handle("shell:openExternal", async (url) => {
    if (isSafeExternalUrl(url)) await shell.openExternal(url);
  });
  handle("app:version", () => app.getVersion());
  handle("settings:get", () => settings.get());
  handle("settings:set", (patch) => {
    const next = settings.set(patch); // throws on an invalid patch
    applySettings(next);
    return next;
  });
  handle("shortcuts:failed", () => shortcuts.failed());
  handle("ptt:status", () => ptt.status());
  handle("ptt:setRoom", (inRoom) => {
    if (typeof inRoom !== "boolean") throw new Error("invalid room flag");
    return ptt.setRoom(inRoom);
  });
  handle("update:get", () => updater.status());
  handle("update:check", () => {
    updater.check();
    return updater.status();
  });
  handle("update:install", () => void updater.install()); // the renderer asked after its confirm dialog; main still acts only when an update is available
  handle("app:uninstall", () => uninstallApp(() => revokeSession(store.get())));
  handle("notify:show", (payload) => notifier.show(payload));
  handle("notify:close", (key) => notifier.close(key));
  handle("badge:set", (count) => {
    const n = normalizeBadge(count);
    if (n === null) throw new Error("invalid badge count");
    app.setBadgeCount(n); // macOS dock / Linux launcher; Windows has no equivalent here (ponytail: taskbar overlay icon)
  });
  handle("screen:sources", () => screenShare.list());
  handle("screen:choose", (id, opts) => screenShare.choose(id, opts));
  handle("media:ensureAccess", (kind) => {
    if (!isMediaKind(kind)) throw new Error("invalid media kind");
    return ensureMediaAccess(kind, process.platform, systemPreferences);
  });
}

const UNINSTALL_PROMPT = {
  type: "warning" as const,
  buttons: ["Hủy", "Gỡ cài đặt"],
  defaultId: 0, // Enter / Esc mean cancel
  cancelId: 0,
  title: "Gỡ cài đặt Loop",
  message: "Gỡ cài đặt Loop khỏi máy tính này?",
  detail:
    "Loop và dữ liệu của nó trên máy này sẽ bị xoá: đăng nhập, cài đặt, bộ nhớ đệm và mục tự khởi động cùng máy. " +
    "Tài khoản và mọi dữ liệu trên máy chủ không bị xoá: cài lại Loop và đăng nhập là có lại tất cả.",
};

/** The native confirmation is the real gate: a compromised renderer cannot click it. */
/** Same call as the renderer's sign-out (POST /auth/logout); the caller bounds the wait and ignores failures. The token is never logged. */
async function revokeSession(refreshToken: string | null) {
  if (!refreshToken) return;
  const res = await net.fetch(`${API_URL}/auth/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }), signal: AbortSignal.timeout(3000) });
  recordUninstall({ action: "revokeRequest", status: res.status });
}

const recordUninstall = (entry: Record<string, unknown>) =>
  void (e2e && process.env.LOOP_E2E_UNINSTALL_LOG && appendFileSync(process.env.LOOP_E2E_UNINSTALL_LOG, `${JSON.stringify(entry)}\n`));

function uninstallApp(revoke: () => Promise<void>) {
  const throwaway = e2e && !!process.env.LOOP_USER_DATA_DIR;
  return runUninstall({
    platform: process.platform,
    isPackaged: app.isPackaged,
    e2e,
    userDataOverridden: throwaway,
    deleteInE2e: process.env.LOOP_E2E_UNINSTALL_DELETE === "1",
    userData: app.getPath("userData"),
    appData: app.getPath("appData"),
    tmpdir: tmpdir(),
    home: app.getPath("home"),
    exe: app.getPath("exe"),
    appName: app.getName(),
    pid: process.pid,
    exists: existsSync,
    confirm: async () => (e2e ? uninstallAnswer : (win && !win.isDestroyed() ? await dialog.showMessageBox(win, UNINSTALL_PROMPT) : await dialog.showMessageBox(UNINSTALL_PROMPT)).response === 1),
    revoke,
    removeLoginItem: () => app.setLoginItemSettings({ openAtLogin: false }),
    teardown: async () => {
      quitting = true;
      tray?.destroy();
      await session.defaultSession.clearStorageData().catch(() => undefined);
      await session.defaultSession.clearCache().catch(() => undefined);
      BrowserWindow.getAllWindows().forEach((w) => w.destroy());
    },
    trash: (path) => shell.trashItem(path),
    spawnDetached: ({ cmd, args, env }) => spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, env: env && { ...process.env, ...env } }).unref(),
    warn: async (message) => void (await dialog.showMessageBox({ type: "info", message, buttons: ["OK"] })),
    exit: () => app.exit(0),
    record: recordUninstall, // e2e only: what was done or would have been done, one JSON line each (the process is gone by the time anyone could ask)
  });
}

const showWindow = () => (win && !win.isDestroyed() ? revealWindow(win) : createWindow(false));
const focusedNow = () => !!win && !win.isDestroyed() && windowIsFocused(win, focusOverride);
// The renderer learns whether it is being looked at (unread marks, notifications) from here, not from the DOM.
const pushFocus = () => win && !win.isDestroyed() && win.webContents.send("window:focus", focusedNow());

// The renderer tells the server when we are away (no keyboard/mouse system-wide for a while); it re-sends after reconnects.
const idleWatch = createIdleWatch({
  getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  send: (away) => win && !win.isDestroyed() && win.webContents.send("presence:idle", away),
});

function createWindow(hidden: boolean) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#171310", // --color-bg-rail: no white flash before the first paint
    title: "Loop",
    // ponytail: native frame for now; a custom title bar comes with the window polish later
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Remote voice plays without a click on the page itself (a call is answered from a dialog, a channel joined from
      // a list; the chosen alternative, room.startAudio() per join, would break when audio arrives after the gesture).
      autoplayPolicy: "no-user-gesture-required",
      additionalArguments: e2e ? ["--loop-e2e"] : [],
    },
  });
  const w = win;
  w.once("ready-to-show", () => !hidden && w.show());
  w.on("focus", pushFocus);
  w.on("blur", pushFocus);
  w.on("show", pushFocus);
  w.on("hide", pushFocus);
  w.on("minimize", pushFocus);
  w.on("restore", pushFocus);
  w.webContents.on("did-finish-load", pushFocus);
  // Closing hides the window when the user chose that (the app lives on in the tray / dock); a real quit goes through.
  w.on("close", (event) => {
    if (!shouldHideOnClose({ closeToTray: settings.get().closeToTray, quitting })) return;
    event.preventDefault();
    w.hide();
  });
  w.on("session-end", () => (quitting = true)); // logging out / shutting down must not be held up by a hidden window
  w.on("closed", () => {
    if (win === w) win = null;
  });
  w.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
}

/** Applies what the settings say outside the renderer: the login item (installed app only), the global shortcuts, push-to-talk and the tray menu. */
function applySettings(s: Settings) {
  const item = loginItemSettings({ isPackaged: app.isPackaged, startAtLogin: s.startAtLogin });
  if (item) app.setLoginItemSettings(item);
  shortcuts.apply(s);
  ptt.apply(s);
  tray?.refresh();
}

function toggleNotifications() {
  settings.set({ notifications: !settings.get().notifications });
  tray?.refresh();
}

function startTray() {
  tray = createTray({
    notifications: () => settings.get().notifications,
    window: () => ({ visible: !!win && win.isVisible(), focused: !!win && win.isFocused() }),
    onToggle: (action) => (action === "hide" ? win?.hide() : showWindow()),
    onItem: (id) => {
      if (id === "open") showWindow();
      else if (id === "quit") app.quit();
      else toggleNotifications();
    },
  });
}

/**
 * Automatic updates: only for the installed app with a baked https feed; otherwise inert (no network). macOS builds are
 * unsigned, which Squirrel.Mac (electron-updater) refuses to install, so macOS uses its own verified swap (mac-updater.ts).
 */
function startUpdater() {
  const feedUrl = updatesEnabled({ isPackaged: app.isPackaged, feedUrl: UPDATE_URL }) ? UPDATE_URL : null;
  const send = (status: UpdateStatus) => win && !win.isDestroyed() && win.webContents.send("update:status", status);
  updater =
    process.platform === "darwin"
      ? createMacUpdater({
          feedUrl,
          send,
          version: app.getVersion(),
          arch: process.arch,
          execPath: process.execPath,
          tempRoot: app.getPath("temp"),
          pid: process.pid,
          spawnDetached: (cmd, args) => spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(),
          quit: () => app.quit(), // before-quit sets `quitting`, so the window closes instead of hiding to the tray
        })
      : createUpdater({ getAutoUpdater: () => autoUpdater, feedUrl, send });
  updater.start();
}

function hookE2e() {
  installE2eHook({
    notifications: () => recorder!.log,
    clickNotification: (key: string) => recorder!.click.get(key)?.(),
    setFocused: (value: boolean | null) => {
      focusOverride = value;
      pushFocus();
    },
    badge: () => app.getBadgeCount(),
    tray: () => ({ exists: !!tray?.exists() }),
    trayClick: () => tray?.click(),
    trayItem: (id: "open" | "notifications" | "quit") => tray && (id === "open" ? showWindow() : id === "quit" ? app.quit() : toggleNotifications()),
    window: () => ({ exists: !!win && !win.isDestroyed(), visible: !!win && win.isVisible() }),
    settings: () => settings.get(),
    setUninstallAnswer: (value: boolean) => (uninstallAnswer = value),
  });
}

// Every web contents (including any a bug might create): no navigation away, no new windows, no webviews.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
});

// One running copy: a second launch just brings the first one forward. (Keyed by userData, so test profiles do not clash.)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => (quitting = true));
  app.on("will-quit", () => {
    idleWatch.stop();
    shortcuts.dispose();
    ptt.dispose();
  });
  app.whenReady().then(() => {
    // Microphone/camera/screen (voice) and writing text to the clipboard, for our own pages only; everything else is refused.
    // Notifications stay refused here on purpose: the renderer asks the main process (IPC `notify:show`) instead.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
      callback(isPermissionAllowed(permission, details.requestingUrl, devServerUrl)),
    );
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => isPermissionAllowed(permission, requestingOrigin, devServerUrl));
    // getDisplayMedia is answered with the source the user picked in the app's dialog (screen.ts), never with a system prompt.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => screenShare.handler(request, callback), { useSystemPicker: false });
    if (devServerUrl) {
      session.defaultSession.webRequest.onHeadersReceived({ urls: [`${devServerUrl}/*`] }, (details, callback) =>
        callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } }),
      );
    } else {
      serveRenderer();
    }
    startUpdater();
    registerIpc();
    applySettings(settings.get()); // keeps the login item in step with the stored choice
    startTray();
    idleWatch.start();
    createWindow(startsHidden({ argv: process.argv, wasOpenedAtLogin: app.getLoginItemSettings().wasOpenedAtLogin }));
    app.on("activate", showWindow);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
