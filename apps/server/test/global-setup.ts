import { execSync } from "node:child_process";

// Apply migrations to the test DB so `pnpm test` works right after `docker compose up -d`.
export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ?? "postgresql://loop:loop@localhost:5432/loop_test";
  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}
