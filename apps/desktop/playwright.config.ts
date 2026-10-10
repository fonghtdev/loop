import { defineConfig } from "@playwright/test";

// A media publish (ICE over Docker's UDP mapping) can take ~7 s to settle, hence the long expect timeout.
// `pnpm e2e`: builds, then drives the built app against the REAL dev server (port 3000) + docker stack.
export default defineConfig({ testDir: "e2e", timeout: 90_000, expect: { timeout: 20_000 }, workers: 1, reporter: "list" });
