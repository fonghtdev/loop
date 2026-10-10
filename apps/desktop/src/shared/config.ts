// The one place the server address is configured (build time: `VITE_API_URL`); everything else derives from it.
export const API_URL = new URL(import.meta.env.VITE_API_URL || "http://localhost:3000").origin;
/** Socket.IO upgrades to a websocket on the same host (used by the CSP now, by the socket client from 9b). */
export const WS_URL = API_URL.replace(/^http/, "ws");
