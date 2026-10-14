// The one place the server address is configured (build time: `VITE_API_URL`); everything else derives from it.
export const API_URL = new URL(import.meta.env.VITE_API_URL || "http://localhost:3000").origin;
/** Socket.IO (given API_URL) starts with HTTP polling and upgrades to this websocket; the CSP allows both. */
export const WS_URL = API_URL.replace(/^http/, "ws");
/**
 * Where uploaded files live (the S3-compatible storage; MinIO in dev). The renderer PUTs uploads to it and shows
 * images from it, so the CSP names it (`connect-src`, `img-src`) and nothing else derives from it. Build time: `VITE_STORAGE_ORIGIN`.
 */
export const STORAGE_ORIGIN = new URL(import.meta.env.VITE_STORAGE_ORIGIN || "http://localhost:9000").origin;
/**
 * Where LiveKit (voice/video) is reached. The server hands out the URL with every token, but a CSP is static, so the
 * renderer may only talk to this one origin (`connect-src`, ws + the http twin LiveKit uses to validate); a token
 * pointing elsewhere is refused with a clear message. Production = the LiveKit Cloud wss URL. Build time: `VITE_LIVEKIT_ORIGIN`.
 */
export const LIVEKIT_ORIGIN = new URL(import.meta.env.VITE_LIVEKIT_ORIGIN || "ws://127.0.0.1:7880").origin;
/**
 * Where the installed app looks for updates (electron-updater "generic" provider: a folder holding latest.yml /
 * latest-mac.yml and the artifacts). Build time: `VITE_UPDATE_URL`. Empty = automatic updates are off and the app makes no update request.
 */
export const UPDATE_URL = import.meta.env.VITE_UPDATE_URL || "";
/** Where a person downloads a new version by hand (macOS, where the app only says that one exists). */
export const RELEASES_URL = "https://github.com/fonghtdev/loop/releases/latest";
