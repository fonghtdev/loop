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
