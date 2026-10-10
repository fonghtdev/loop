import { defineConfig } from "@playwright/test";

// `pnpm e2e`: builds, then drives the built app against the REAL dev server (port 3000) + docker stack.
export default defineConfig({ testDir: "e2e", timeout: 90_000, workers: 1, reporter: "list" });
