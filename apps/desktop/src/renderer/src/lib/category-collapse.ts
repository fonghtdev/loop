import { useSyncExternalStore } from "react";

/** Which categories the user folded. Per ACCOUNT, kept on this machine (ids are globally unique, so no guild in the key); default: all open. */
export const collapseKey = (userId: string) => `loop.collapsed.${userId}`;

type Store = Pick<Storage, "getItem" | "setItem">;

/** Anything -> a set of ids; corrupt storage means nothing is folded. */
export function parseCollapsed(raw: string | null | undefined): ReadonlySet<string> {
  try {
    const list: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Storage is injected so the logic runs without a browser; any storage failure just means the choice holds for this run. */
export function createCollapse(storage: () => Store | undefined) {
  let user: string | null = null;
  let current: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlySet<string>) => {
    current = next; // a new Set each time: that is what useSyncExternalStore compares
    listeners.forEach((l) => l());
  };
  return {
    get: () => current,
    /** The account whose choices apply (null = signed out: nothing of the last account stays). */
    load(userId: string | null) {
      user = userId;
      try {
        publish(userId ? parseCollapsed(storage()?.getItem(collapseKey(userId))) : new Set());
      } catch {
        publish(new Set());
      }
    },
    toggle(categoryId: string) {
      const next = new Set(current);
      if (!next.delete(categoryId)) next.add(categoryId);
      try {
        if (user) storage()?.setItem(collapseKey(user), JSON.stringify([...next]));
      } catch {
        // storage blocked or full
      }
      publish(next);
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const collapse = createCollapse(() => globalThis.window?.localStorage);

export const useCollapsed = () => useSyncExternalStore(collapse.subscribe, collapse.get);
