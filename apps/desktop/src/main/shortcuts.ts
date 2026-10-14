import type { Settings } from "../shared/settings";
import type { ShortcutAction } from "../shared/shortcut";

type GlobalShortcut = { register(accelerator: string, cb: () => void): boolean; unregister(accelerator: string): void };

/**
 * Keeps the OS-level shortcuts in step with the settings. `apply` drops what it registered before and registers what the
 * settings say now (none for ""); an accelerator the OS refuses (another app owns it) is not kept as registered and shows in `failed`.
 * ponytail: unregisters by accelerator, so it never touches a shortcut another part of Loop might register; add a prefix if one ever does.
 */
export function createShortcuts({ globalShortcut, onPress }: { globalShortcut: GlobalShortcut; onPress: (action: ShortcutAction) => void }) {
  let registered: string[] = [];
  let failed: ShortcutAction[] = [];
  const release = () => {
    registered.forEach((a) => globalShortcut.unregister(a));
    registered = [];
  };
  return {
    apply({ micShortcut, deafenShortcut }: Pick<Settings, "micShortcut" | "deafenShortcut">) {
      release();
      failed = [];
      for (const [action, accelerator] of [["mic", micShortcut], ["deafen", deafenShortcut]] as const) {
        if (!accelerator) continue;
        let ok = false;
        try {
          ok = globalShortcut.register(accelerator, () => onPress(action));
        } catch {
          // an accelerator the OS rejects outright: same as taken
        }
        if (ok) registered.push(accelerator);
        else failed.push(action);
      }
    },
    failed: () => failed,
    dispose: release,
  };
}
