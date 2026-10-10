function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
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
    port: Number(process.env.PORT ?? 3000),
    // Browser origins allowed to call the API and Socket.IO (desktop renderer: Vite dev origin, `app://loop`).
    // Unset or empty = no cross-origin access at all (fail-safe); non-browser clients are unaffected.
    corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  };
}

// refreshGraceMs: tests only (0 = no grace); unset = REFRESH_GRACE_MS.
export type Env = ReturnType<typeof loadEnv> & { refreshGraceMs?: number };
