import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from "electron";
import { API_URL, WS_URL } from "../shared/config";
import { APP_ORIGIN, buildCsp, isSafeExternalUrl, isTrustedSender, isValidRefreshToken, resolveAppFile } from "./security";
import { createTokenStore } from "./token-store";

// Set by electron-vite in dev only; production loads the built renderer from app://loop.
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const rendererDir = join(__dirname, "../renderer");
const csp = buildCsp(API_URL, WS_URL, devServerUrl);

// Test/dev hook: a separate profile (the E2E smoke test relaunches against the same one).
if (process.env.LOOP_USER_DATA_DIR) app.setPath("userData", process.env.LOOP_USER_DATA_DIR);

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
}

function createWindow() {
  const win = new BrowserWindow({
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
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
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

app.whenReady().then(() => {
  // ponytail: every permission (camera, mic, notifications...) is refused; voice (9d) and notifications (9f) open theirs.
  // Only writing plain text to the clipboard (copy invite code / message) is allowed; reading it stays refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "clipboard-sanitized-write"));
  if (devServerUrl) {
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${devServerUrl}/*`] }, (details, callback) =>
      callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } }),
    );
  } else {
    serveRenderer();
  }
  registerIpc();
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
