import { normalize, resolve, sep } from "node:path";

/** The production renderer's origin (custom privileged scheme, see index.ts); the server's CORS allowlist names it. */
export const APP_ORIGIN = "app://loop";

// Shared with the renderer (linkify), which cannot import this node:path module.
export { isSafeExternalUrl } from "../shared/url";

// Node's URL gives non-special schemes an opaque "null" origin, so app:// URLs are compared by scheme + host.
const isAppUrl = (u: URL) => u.protocol === "app:" && u.host === "loop";

/** IPC is answered only for our own pages (the app origin, or the Vite dev server in dev). */
export function isTrustedSender(url: string, devServerUrl?: string) {
  try {
    const u = new URL(url);
    return isAppUrl(u) || (!!devServerUrl && u.origin === new URL(devServerUrl).origin);
  } catch {
    return false;
  }
}

/** Refresh tokens are 43-char base64url strings; anything else from the renderer is refused. */
export const isValidRefreshToken = (t: unknown): t is string =>
  typeof t === "string" && t.length <= 512 && /^[A-Za-z0-9_-]+$/.test(t);

/**
 * GIF previews and messages load straight from GIPHY's CDN (exact hosts, no wildcard). Kept in step with `GIF_HOSTS` of
 * @loop/shared by a test (the main process does not import the shared package). The CSP is fixed at startup, so these are
 * allowed even when the server has no GIF provider; nothing is requested from them unless a GIF is shown.
 */
export const GIF_IMG_HOSTS = ["media0", "media1", "media2", "media3", "media4", "i"].map((h) => `https://${h}.giphy.com`);

/**
 * The CSP for every renderer response. Production: no inline code at all; the network is the API origin, its
 * websocket, the storage origin (upload PUTs) and LiveKit (its websocket, plus the http twin it fetches to explain a
 * failed connection; the media itself is WebRTC, which a CSP does not govern); images also from the storage origin (attachments), GIPHY's CDN hosts and
 * data:/blob: (local previews). Dev: the Vite dev server needs inline scripts/styles (React refresh preamble,
 * injected CSS) and its HMR websocket. `'wasm-unsafe-eval'` (compiling WebAssembly, NOT eval of strings) is the one script
 * relaxation, in both: the noise-suppression AudioWorklet inherits this policy and instantiates RNNoise's wasm. The
 * worklet and wasm files are our own bundle (`'self'`, fetched under `connect-src 'self'`).
 */
export function buildCsp({ api, ws, storage, livekit }: { api: string; ws: string; storage: string; livekit: string }, devServerUrl?: string) {
  const devWs = devServerUrl ? ` ${devServerUrl.replace(/^http/, "ws")}` : "";
  const inline = devServerUrl ? " 'unsafe-inline'" : "";
  return [
    "default-src 'none'",
    `script-src 'self' 'wasm-unsafe-eval'${inline}`,
    `style-src 'self'${inline}`,
    "font-src 'self'",
    `img-src 'self' data: blob: ${api} ${storage} ${GIF_IMG_HOSTS.join(" ")}`,
    `connect-src 'self' ${api} ${ws} ${storage} ${livekit} ${livekit.replace(/^ws/, "http")}${devWs}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Maps `app://loop/<path>` to a file inside `rootDir`; null for another host or a path escaping the root. */
export function resolveAppFile(rootDir: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (!isAppUrl(url)) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const root = resolve(rootDir);
  const file = resolve(root, "." + normalize(path === "/" ? "/index.html" : path));
  return file.startsWith(root + sep) ? file : null;
}

/**
 * Permissions the renderer may be granted, decided by one pure function for both the request and the check handler:
 * microphone/camera ("media"), screen capture ("display-capture"; which screen is still the main process's call, see
 * screen.ts), HTML fullscreen (the stream's fullscreen button) and writing text to the clipboard, and only for our own pages. Everything else is refused.
 */
export function isPermissionAllowed(permission: string, requestingUrl: string, devServerUrl?: string): boolean {
  return (permission === "media" || permission === "display-capture" || permission === "fullscreen" || permission === "clipboard-sanitized-write") && isTrustedSender(requestingUrl, devServerUrl);
}

export type MediaKind = "microphone" | "camera" | "screen";
export const isMediaKind = (k: unknown): k is MediaKind => k === "microphone" || k === "camera" || k === "screen";

/**
 * macOS gates the microphone and camera per app at the OS level, and only the main process can ask. Elsewhere
 * (Windows asks no app-level question through Electron) there is nothing to do. false = denied / restricted:
 * the user has to enable it in System Settings. The screen cannot be asked for: macOS prompts by itself when the
 * first capture starts, so "not-determined" lets it through.
 */
export async function ensureMediaAccess(
  kind: MediaKind,
  platform: string,
  sp: { getMediaAccessStatus(k: MediaKind): string; askForMediaAccess(k: "microphone" | "camera"): Promise<boolean> },
): Promise<boolean> {
  if (platform !== "darwin") return true;
  const status = sp.getMediaAccessStatus(kind);
  if (status === "granted") return true;
  if (status !== "not-determined") return false;
  return kind === "screen" ? true : sp.askForMediaAccess(kind);
}
