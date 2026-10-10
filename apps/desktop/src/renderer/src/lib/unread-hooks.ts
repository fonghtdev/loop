import { useStore } from "zustand";
import { unread } from "./app";
import { dmTotal, unreadOf, type UnreadState } from "./unread";

/** What a conversation row shows: a live count, a dot (restart detection / channels), or nothing. */
export function useUnreadMark(key: string): { count: number; dot: boolean } {
  const count = useStore(unread.store, (s: UnreadState) => s.counts[key] ?? 0);
  const dot = useStore(unread.store, (s) => !!s.dots[key]);
  return { count, dot: dot && count === 0 };
}
/** Unread DMs in total (the Home button). */
export const useDmTotal = () => useStore(unread.store, dmTotal);
export const useUnreadCount = (key: string) => useStore(unread.store, (s) => unreadOf(s, key));
