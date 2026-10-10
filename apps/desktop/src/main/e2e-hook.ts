import type { createNotifier } from "./notifications";

type Recorded = NonNullable<Parameters<typeof createNotifier>[0]["record"]>;
export const newRecorder = (): Recorded => ({ log: [], click: new Map() });

/**
 * Test-only introspection, installed ONLY when LOOP_E2E=1 (Playwright reads it through electronApp.evaluate). It lets the
 * end-to-end run drive "the window is (not) focused", read the notifications the app would have shown, click one, and
 * check the dock badge and the tray, without depending on the OS focus state. Nothing here is reachable from the renderer.
 */
export function installE2eHook(hook: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).__loopE2E = hook;
}
