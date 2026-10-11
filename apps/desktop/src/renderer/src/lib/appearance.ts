import { useSyncExternalStore } from "react";

/** Film grain on the big solid surfaces, and how much the UI moves. Per device (localStorage), applied to <html>. */
export type Appearance = { grain: "on" | "off"; motion: "system" | "reduced" | "full" };

export const GRAINS = ["on", "off"] as const;
export const MOTIONS = ["system", "reduced", "full"] as const;
export const DEFAULT_APPEARANCE: Appearance = { grain: "on", motion: "system" };
const KEY = "loop.appearance";

/** Anything -> a valid Appearance: each unknown or missing field falls back to its default. */
export function parseAppearance(raw: unknown): Appearance {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    grain: GRAINS.find((g) => g === o.grain) ?? DEFAULT_APPEARANCE.grain,
    motion: MOTIONS.find((m) => m === o.motion) ?? DEFAULT_APPEARANCE.motion,
  };
}

/** Whether animations should be skipped: the in-app choice wins, "system" follows the OS setting. */
export const isReducedMotion = (motion: Appearance["motion"], systemReduced: boolean) => (motion === "system" ? systemReduced : motion === "reduced");

type Root = { dataset: Record<string, string | undefined> };
type Store = Pick<Storage, "getItem" | "setItem">;

/** The attributes the CSS keys on (`html[data-grain="off"]`, `html[data-motion="reduced"]`). */
export function applyAppearance(a: Appearance, root: Root) {
  root.dataset.grain = a.grain;
  root.dataset.motion = a.motion;
}

/** Storage and root are injected so the logic runs without a browser; any storage failure just means defaults. */
export function createAppearance(storage: () => Store | undefined, root: () => Root | undefined) {
  const listeners = new Set<() => void>();
  const read = (): Appearance => {
    try {
      const raw = storage()?.getItem(KEY);
      return parseAppearance(raw ? JSON.parse(raw) : null);
    } catch {
      return DEFAULT_APPEARANCE;
    }
  };
  let current = read();
  const apply = () => {
    const r = root();
    if (r) applyAppearance(current, r);
  };
  return {
    get: () => current,
    /** Call once at startup, before the first render. */
    init: apply,
    set(patch: Partial<Appearance>) {
      current = parseAppearance({ ...current, ...patch });
      try {
        storage()?.setItem(KEY, JSON.stringify(current));
      } catch {
        // storage blocked or full: the choice still holds for this run
      }
      apply();
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const appearance = createAppearance(
  () => globalThis.window?.localStorage,
  () => globalThis.document?.documentElement,
);

export const useAppearance = () => useSyncExternalStore(appearance.subscribe, appearance.get);
