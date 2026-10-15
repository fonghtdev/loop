import { createStore } from "zustand/vanilla";
import type { GoLivePrefs, ShareChoice } from "./golive";

export type ScreenSource = { id: string; name: string; thumbnail: string };
export type ShareDevice = { id: string; label: string };
type Deps = { list: () => Promise<ScreenSource[]>; devices: () => Promise<ShareDevice[]>; save: (prefs: GoLivePrefs) => void };

/**
 * The Go Live dialog as state: `pick()` lists the screens, windows and cameras, opens the dialog (`open` non-null)
 * and resolves the choice once the user confirms it, or null when they cancel (or something else closes the dialog).
 * Confirming also remembers the quality and sound switch for next time (never the source).
 */
export function createScreenPicker({ list, devices, save }: Deps) {
  const store = createStore<{ open: { sources: ScreenSource[]; devices: ShareDevice[] } | null }>(() => ({ open: null }));
  let waiting: ((choice: ShareChoice | null) => void) | null = null;
  const close = () => {
    store.setState({ open: null });
    waiting = null;
  };
  const cancel = () => {
    waiting?.(null);
    close();
  };
  return {
    store,
    async pick(): Promise<ShareChoice | null> {
      cancel();
      const [sources, cams] = await Promise.all([list(), devices()]);
      store.setState({ open: { sources, devices: cams } });
      return new Promise((resolve) => (waiting = resolve));
    },
    confirm(choice: ShareChoice, prefs: GoLivePrefs) {
      const resolve = waiting;
      if (!resolve) return; // a second click on the same source: already started
      close();
      save(prefs);
      resolve?.(choice);
    },
    cancel,
  };
}
export type ScreenPicker = ReturnType<typeof createScreenPicker>;
