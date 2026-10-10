// The one place the server address is configured (build time: `VITE_API_URL`); everything else derives from it.
export const API_URL = new URL(import.meta.env.VITE_API_URL || "http://localhost:3000").origin;
/** Socket.IO (given API_URL) starts with HTTP polling and upgrades to this websocket; the CSP allows both. */
export const WS_URL = API_URL.replace(/^http/, "ws");
/**
 * Where uploaded files live (the S3-compatible storage; MinIO in dev). The renderer PUTs uploads to it and shows
 * images from it, so the CSP names it (`connect-src`, `img-src`) and nothing else derives from it. Build time: `VITE_STORAGE_ORIGIN`.
 */
export const STORAGE_ORIGIN = new URL(import.meta.env.VITE_STORAGE_ORIGIN || "http://localhost:9000").origin;
