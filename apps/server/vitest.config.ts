import { defineConfig } from "vitest/config";

// Tests always use the separate loop_test database, never the dev one.
const testDb =
  process.env.TEST_DATABASE_URL ?? "postgresql://loop:loop@localhost:5432/loop_test";

// Redis DB index 1 (dev uses 0). Tests may FLUSHDB that index only.
const testRedis = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";

// Own bucket, emptied between tests; never the dev bucket.
const s3 = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_BUCKET: process.env.TEST_S3_BUCKET ?? "loop-test",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "loopminio",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "loopminio-secret",
};

// The dev LiveKit container; tests use unique channel ids, so rooms never collide with anything else.
const livekit = {
  LIVEKIT_URL: process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880",
  LIVEKIT_API_URL: process.env.LIVEKIT_API_URL ?? "http://127.0.0.1:7880",
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? "devkey",
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? "loop-dev-livekit-secret-0123456789abcdef",
};

export default defineConfig({
  test: {
    env: { DATABASE_URL: testDb, REDIS_URL: testRedis, ...s3, ...livekit },
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
  },
});
