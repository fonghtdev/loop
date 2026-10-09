import { defineConfig } from "vitest/config";

// Tests always use the separate loop_test database, never the dev one.
const testDb =
  process.env.TEST_DATABASE_URL ?? "postgresql://loop:loop@localhost:5432/loop_test";

export default defineConfig({
  test: {
    env: { DATABASE_URL: testDb },
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
  },
});
