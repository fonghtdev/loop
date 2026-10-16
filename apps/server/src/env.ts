import type { Redis } from "ioredis";
import type { Fetcher } from "./embeds/fetch.js";
import type { AuditWriter } from "./guilds/audit.js";
import type { GiphyFetch } from "./gifs/giphy.js";
import type { PolicyOverrides } from "./rate-limits.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

/** off (default) | true: trust X-Forwarded-For as sent | N: trust N proxy hops (safest behind a known proxy chain). */
function trustProxy(value = ""): boolean | number {
  if (["", "off", "false"].includes(value)) return false;
  if (["on", "true"].includes(value)) return true;
  if (/^[1-9]\d?$/.test(value)) return Number(value);
  throw new Error("TRUST_PROXY must be off, true or a number of proxy hops");
}

export function loadEnv() {
  const jwtSecret = required("JWT_SECRET");
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  return {
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    jwtSecret,
    s3: {
      endpoint: required("S3_ENDPOINT"),
      region: required("S3_REGION"),
      bucket: required("S3_BUCKET"),
      accessKey: required("S3_ACCESS_KEY"),
      secretKey: required("S3_SECRET_KEY"),
    },
    livekit: {
      url: required("LIVEKIT_URL"), // ws(s):// address clients connect to
      apiUrl: required("LIVEKIT_API_URL"), // http(s):// address the server calls
      apiKey: required("LIVEKIT_API_KEY"),
      apiSecret: required("LIVEKIT_API_SECRET"),
    },
    // Secure default: anything but "off" keeps rate limiting on. "off" is for dev, e2e and tests only.
    rateLimit: process.env.RATE_LIMIT !== "off",
    // Link previews: the server fetches pages linked in messages (its IP shows up at those sites). "off" disables it.
    linkPreviews: process.env.LINK_PREVIEWS !== "off",
    // GIF search (GIPHY). Unset = the feature is off and the desktop hides its button. Never sent to clients.
    giphyApiKey: process.env.GIPHY_API_KEY?.trim() || undefined,
    trustProxy: trustProxy(process.env.TRUST_PROXY),
    port: Number(process.env.PORT ?? 3000),
    // Browser origins allowed to call the API and Socket.IO (desktop renderer: Vite dev origin, `app://loop`).
    // Unset or empty = no cross-origin access at all (fail-safe); non-browser clients are unaffected.
    corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  };
}

// refreshGraceMs: tests only (0 = no grace); unset = REFRESH_GRACE_MS.
// rateLimitOverrides: tests only (smaller limits, a private key namespace, a stand-in Redis).
// gifOverrides: tests only (a fake provider instead of api.giphy.com).
// embedOverrides: tests only (a fake fetcher instead of the network, a smaller queue).
// auditWriter: tests only (an audit insert that fails).
export type Env = ReturnType<typeof loadEnv> & {
  refreshGraceMs?: number;
  rateLimitOverrides?: { policies?: PolicyOverrides; namespace?: string; redis?: Redis };
  gifOverrides?: { fetchJson?: GiphyFetch; ttlMs?: number };
  embedOverrides?: { fetcher?: Fetcher; concurrency?: number; queueMax?: number };
  auditWriter?: AuditWriter;
};
