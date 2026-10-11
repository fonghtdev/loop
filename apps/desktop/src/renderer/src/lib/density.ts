import { useSyncExternalStore } from "react";

/** How tight the message list is: "Thoải mái" (comfy) or "Gọn" (compact). Per ACCOUNT, applied to <html data-density>. */
export const DENSITIES = ["comfy", "compact"] as const;
export type Density = (typeof DENSITIES)[number];
export const DEFAULT_DENSITY: Density = "comfy";

/** Anything -> a valid density; a stored value we do not know falls back to the default. */
export const parseDensity = (raw: unknown): Density => DENSITIES.find((d) => d === raw) ?? DEFAULT_DENSITY;

export const densityKey = (userId: string) => `loop.density.${userId}`;

type Store = Pick<Storage, "getItem" | "setItem">;
type Root = { dataset: Record<string, string | undefined> };

/** Storage and root are injected so the logic runs without a browser; any storage failure just means the default. */
export function createDensity(storage: () => Store | undefined, root: () => Root | undefined) {
  let user: string | null = null;
  let current: Density = DEFAULT_DENSITY;
  const listeners = new Set<() => void>();
  const publish = () => {
    const r = root();
    if (r) r.dataset.density = current;
    listeners.forEach((l) => l());
  };
  return {
    get: () => current,
    /** The account whose preference applies (null = signed out: the default, nothing of the last account stays). */
    load(userId: string | null) {
      user = userId;
      try {
        current = userId ? parseDensity(storage()?.getItem(densityKey(userId))) : DEFAULT_DENSITY;
      } catch {
        current = DEFAULT_DENSITY;
      }
      publish();
    },
    set(next: Density) {
      current = parseDensity(next);
      try {
        if (user) storage()?.setItem(densityKey(user), current);
      } catch {
        // storage blocked or full: the choice still holds for this run
      }
      publish();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const density = createDensity(
  () => globalThis.window?.localStorage,
  () => globalThis.document?.documentElement,
);

export const useDensity = () => useSyncExternalStore(density.subscribe, density.get);
