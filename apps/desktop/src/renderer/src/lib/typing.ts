import { createStore } from "zustand/vanilla";
import { t } from "../i18n/t";
import type { ConvKey } from "./conversation";

/** Someone who stops sending `typing` is gone after this; a message of theirs ends it at once. */
export const TYPING_EXPIRE_MS = 8_000;
/** While the draft is not empty, `typing` goes out at most this often per conversation. */
export const TYPING_SEND_MS = 5_000;

type Typers = Record<string, string[]>; // conversation -> user ids, the one who started first first

/** Who is typing where, from `typing` events. Ephemeral: nothing persists, `reset()` on sign-out. */
export function createTyping({ expireMs = TYPING_EXPIRE_MS }: { expireMs?: number } = {}) {
  const store = createStore<{ typers: Typers }>(() => ({ typers: {} }));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const id = (key: ConvKey, userId: string) => `${key}|${userId}`;
  const set = (fn: (t: Typers) => Typers) => store.setState((s) => ({ typers: fn(s.typers) }));

  function remove(key: ConvKey, userId: string) {
    const timer = timers.get(id(key, userId));
    clearTimeout(timer);
    timers.delete(id(key, userId));
    if (!store.getState().typers[key]?.includes(userId)) return;
    set(({ [key]: list, ...rest }) => {
      const left = (list ?? []).filter((u) => u !== userId);
      return left.length ? { ...rest, [key]: left } : rest;
    });
  }

  return {
    store,
    /** `typing` arrived: they are typing for another `expireMs`. */
    receive(key: ConvKey, userId: string) {
      clearTimeout(timers.get(id(key, userId)));
      timers.set(id(key, userId), setTimeout(() => remove(key, userId), expireMs));
      if (!store.getState().typers[key]?.includes(userId)) set((typers) => ({ ...typers, [key]: [...(typers[key] ?? []), userId] }));
    },
    /** Their message arrived (or they were blocked): they are not typing any more. */
    stop: remove,
    reset() {
      timers.forEach(clearTimeout);
      timers.clear();
      store.setState({ typers: {} });
    },
  };
}
export type Typing = ReturnType<typeof createTyping>;

/** "A đang gõ...", "A và B đang gõ...", "Nhiều người đang gõ..." (three or more); "" for nobody. */
export function typingText(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return t("typing.one", { a: names[0]! });
  if (names.length === 2) return t("typing.two", { a: names[0]!, b: names[1]! });
  return t("typing.many");
}

/**
 * Decides when the composer tells the server the user is typing: not for an empty draft, and once per `intervalMs`
 * per conversation while the draft goes on. Sending a message forgets the timer, so the next draft announces itself at once.
 */
export function createTypingSender({ send, intervalMs = TYPING_SEND_MS, now = Date.now }: { send: (key: ConvKey) => void; intervalMs?: number; now?: () => number }) {
  const last = new Map<ConvKey, number>();
  return {
    draftChanged(key: ConvKey, draft: string) {
      if (!draft.trim()) return;
      const at = now();
      if (at - (last.get(key) ?? -Infinity) < intervalMs) return;
      last.set(key, at);
      send(key);
    },
    sent: (key: ConvKey) => void last.delete(key),
    reset: () => last.clear(),
  };
}
