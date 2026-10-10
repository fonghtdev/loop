import { defineConfig } from "vitest/config";

// Logic only (node environment); UI is verified by running the app and the Playwright smoke test (`pnpm e2e`).
export default defineConfig({ test: { include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"] } });
