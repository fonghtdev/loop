import { createStore } from "zustand/vanilla";
import { DEFAULT_SETTINGS, type Settings } from "../../../shared/settings";

type Api = { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> };

/** The main process's settings as the renderer sees them (the main process is the source of truth; every change round-trips). */
export function createAppSettings(api: Api) {
  const store = createStore<{ settings: Settings }>(() => ({ settings: DEFAULT_SETTINGS }));
  return {
    store,
    /** Reads them (at sign-in, and when the settings view opens, since the tray can change one meanwhile). */
    async load() {
      try {
        store.setState({ settings: await api.get() });
      } catch {
        // keep what we have: defaults until the next try
      }
    },
    /** Applies a change in the main process; resolves to the settings in force, rejects when refused. */
    async save(patch: Partial<Settings>) {
      const settings = await api.set(patch);
      store.setState({ settings });
      return settings;
    },
  };
}
