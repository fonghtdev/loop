import { defineConfig } from "vitest/config";

// Tests always use the separate loop_test database, never the dev one.
const testDb =
  process.env.TEST_DATABASE_URL ?? "postgresql://loop:loop@localhost:5432/loop_test";

// Redis DB index 1 (dev uses 0). Tests may FLUSHDB that index only.
const testRedis = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";

export default defineConfig({
  test: {
    env: { DATABASE_URL: testDb, REDIS_URL: testRedis },
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
  },
});
