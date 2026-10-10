import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, ipcMain, net, Notification, protocol, safeStorage, session, shell, systemPreferences, type IpcMainInvokeEvent } from "electron";
import { APP_ID } from "../shared/app-id";
import { API_URL, LIVEKIT_ORIGIN, STORAGE_ORIGIN, UPDATE_URL, WS_URL } from "../shared/config";
import type { Settings } from "../shared/settings";
import { updatesEnabled } from "../shared/update";
import { APP_ORIGIN, buildCsp, ensureMediaAccess, isMediaKind, isPermissionAllowed, isSafeExternalUrl, isTrustedSender, isValidRefreshToken, resolveAppFile } from "./security";
import { installE2eHook, newRecorder } from "./e2e-hook";
import { createNotifier } from "./notifications";
import { loginItemSettings, normalizeBadge, revealWindow, shouldHideOnClose, startsHidden, windowIsFocused } from "./policy";
import { createSettingsStore } from "./settings";
import { createTokenStore } from "./token-store";
import { createTray, type TrayHandle } from "./tray";
import { createUpdater } from "./updater";

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
let settings: ReturnType<typeof createSettingsStore>;
let updater: ReturnType<typeof createUpdater>;

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
  handle("update:get", () => updater.status());
  handle("update:check", () => {
    updater.check();
    return updater.status();
  });
  handle("update:install", () => updater.install());
  handle("notify:show", (payload) => notifier.show(payload));
  handle("notify:close", (key) => notifier.close(key));
  handle("badge:set", (count) => {
    const n = normalizeBadge(count);
    if (n === null) throw new Error("invalid badge count");
    app.setBadgeCount(n); // macOS dock / Linux launcher; Windows has no equivalent here (ponytail: taskbar overlay icon)
  });
  handle("media:ensureAccess", (kind) => {
    if (!isMediaKind(kind)) throw new Error("invalid media kind");
    return ensureMediaAccess(kind, process.platform, systemPreferences);
  });
}

const showWindow = () => (win && !win.isDestroyed() ? revealWindow(win) : createWindow(false));
const focusedNow = () => !!win && !win.isDestroyed() && windowIsFocused(win, focusOverride);
// The renderer learns whether it is being looked at (unread marks, notifications) from here, not from the DOM.
const pushFocus = () => win && !win.isDestroyed() && win.webContents.send("window:focus", focusedNow());

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

/** Applies what the settings say outside the renderer: the login item (installed app only) and the tray menu. */
function applySettings(s: Settings) {
  const item = loginItemSettings({ isPackaged: app.isPackaged, startAtLogin: s.startAtLogin });
  if (item) app.setLoginItemSettings(item);
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

/** Automatic updates: only for the installed app with a baked https feed; otherwise inert (no network). */
function startUpdater() {
  const enabled = updatesEnabled({ isPackaged: app.isPackaged, feedUrl: UPDATE_URL });
  updater = createUpdater({
    getAutoUpdater: () => autoUpdater,
    feedUrl: enabled ? UPDATE_URL : null,
    send: (status) => win && !win.isDestroyed() && win.webContents.send("update:status", status),
  });
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
  app.whenReady().then(() => {
    // Microphone/camera (voice) and writing text to the clipboard, for our own pages only; everything else is refused.
    // Notifications stay refused here on purpose: the renderer asks the main process (IPC `notify:show`) instead.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
      callback(isPermissionAllowed(permission, details.requestingUrl, devServerUrl)),
    );
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => isPermissionAllowed(permission, requestingOrigin, devServerUrl));
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
    createWindow(startsHidden({ argv: process.argv, wasOpenedAtLogin: app.getLoginItemSettings().wasOpenedAtLogin }));
    app.on("activate", showWindow);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
