import { useStore } from "zustand";
import { unread } from "./app";
import { dmTotal, mentionsOf, railMark, unreadOf } from "./unread";

/** Unread DMs in total (the Home button). */
export const useDmTotal = () => useStore(unread.store, dmTotal);
/** Unread messages of one conversation (the badge on its row). */
export const useUnreadCount = (key: string) => useStore(unread.store, (s) => unreadOf(s, key));
/** Unread mentions of one conversation (the red badge on a channel row) and of one server (the rail badge). */
export const useMentionCount = (key: string) => useStore(unread.store, (s) => mentionsOf(s, key));
export const useRailMark = (guildId: string) => useStore(unread.store, (s) => railMark(s, guildId));
export const useGuildMentions = (guildId: string) => useStore(unread.store, (s) => s.guildMentions[guildId] ?? 0);
