// The one place the server address is configured (build time: `VITE_API_URL`); everything else derives from it.
export const API_URL = new URL(import.meta.env.VITE_API_URL || "http://localhost:3000").origin;
/** Socket.IO (given API_URL) starts with HTTP polling and upgrades to this websocket; the CSP allows both. */
export const WS_URL = API_URL.replace(/^http/, "ws");
