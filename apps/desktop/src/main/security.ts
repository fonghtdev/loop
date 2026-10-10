import { normalize, resolve, sep } from "node:path";

/** The production renderer's origin (custom privileged scheme, see index.ts); the server's CORS allowlist names it. */
export const APP_ORIGIN = "app://loop";

/** Only web links leave the app, and only through the OS browser: no file:, javascript:, data:, custom schemes. */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

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
 * The CSP for every renderer response. Production: no inline code at all; the network is the API origin and its
 * websocket only; images also from data:/blob: (attachment previews arrive from storage origins in 9c and get
 * added here then). Dev: the Vite dev server needs inline scripts/styles (React refresh preamble, injected CSS)
 * and its HMR websocket.
 */
export function buildCsp(apiUrl: string, wsUrl: string, devServerUrl?: string) {
  const devWs = devServerUrl ? ` ${devServerUrl.replace(/^http/, "ws")}` : "";
  const inline = devServerUrl ? " 'unsafe-inline'" : "";
  return [
    "default-src 'none'",
    `script-src 'self'${inline}`,
    `style-src 'self'${inline}`,
    "font-src 'self'",
    `img-src 'self' data: blob: ${apiUrl}`,
    `connect-src 'self' ${apiUrl} ${wsUrl}${devWs}`,
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
