import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parsePatch, parseSettings, type Settings } from "../shared/settings";

/**
 * The settings file in userData. Read once (corrupt or missing = defaults), validated on every change, written
 * atomically (tmp then rename) so a crash never leaves a torn file.
 */
export function createSettingsStore(file: string) {
  let current: Settings;
  try {
    current = parseSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    current = parseSettings(null);
  }
  return {
    get: (): Settings => current,
    /** Merges a validated patch; throws on an invalid one or one that gives both shortcuts the same keys (nothing changes). */
    set(raw: unknown): Settings {
      const patch = parsePatch(raw);
      if (!patch) throw new Error("invalid settings");
      const next = { ...current, ...patch };
      if (next.micShortcut && next.micShortcut === next.deafenShortcut) throw new Error("shortcuts clash");
      writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      current = next;
      return next;
    },
  };
}
