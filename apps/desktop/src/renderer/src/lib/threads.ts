import { hasPermission, Permission, type ThreadDeletedEvent, type ThreadDto } from "@loop/shared";
import type { QueryClient } from "@tanstack/react-query";
import { createStore } from "zustand/vanilla";

/**
 * Threads (contract in apps/server/CLAUDE.md "Luồng"). A thread IS a channel on the server: its messages, unread
 * counts, typing, pins and subscription all use the channel paths with the thread id, so its conversation key is the
 * plain `channel:<threadId>` (lib/conversation.ts): no second kind to translate at every place an event names a
 * channel id. What is thread-specific lives here: the lists per channel, the open panel, and who may do what.
 */
export type Thread = ThreadDto;
export type ThreadEvent = { type: "thread:created" | "thread:updated"; thread: Thread } | { type: "thread:deleted"; gone: ThreadDeletedEvent };

/** The two lists of a channel's threads in the query cache: the active ones and the archived ones. */
export const threadsKey = (channelId: string, archived: boolean) => ["threads", channelId, archived ? "archived" : "active"] as const;
export const threadsPath = (channelId: string, archived: boolean) => `/channels/${channelId}/threads${archived ? "?archived=true" : ""}`;

const activity = (t: Thread) => t.lastMessageAt ?? t.createdAt;
/** The server's order: newest activity first (ISO times compare as strings), then newest created. */
export const sortThreads = (list: Thread[]) => [...list].sort((a, b) => activity(b).localeCompare(activity(a)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

const idOf = (e: ThreadEvent) => (e.type === "thread:deleted" ? e.gone.id : e.thread.id);
export const parentOf = (e: ThreadEvent) => (e.type === "thread:deleted" ? e.gone.parentChannelId : e.thread.parentChannelId);

/**
 * One list (active or archived) after an event: the thread is in it exactly when its `archived` matches, in order.
 * Idempotent, so the echo of our own change and the copy from the parent's room change nothing more.
 */
export function reduceThreadList(list: Thread[], e: ThreadEvent, archived: boolean): Thread[] {
  const rest = list.filter((t) => t.id !== idOf(e));
  if (e.type === "thread:deleted" || e.thread.archived !== archived) return rest.length === list.length ? list : rest;
  return sortThreads([...rest, e.thread]);
}

/** Both cached lists of the thread's channel follow the event (a list never fetched stays unfetched). */
export function applyThreadEvent(qc: QueryClient, e: ThreadEvent) {
  for (const archived of [false, true]) qc.setQueryData<Thread[]>(threadsKey(parentOf(e), archived), (old) => (old ? reduceThreadList(old, e, archived) : old));
}

/** The starter message's `thread` after an event (null once deleted); messages that did not start it are untouched. */
export function starterUpdate(e: ThreadEvent): { messageId: string | null; thread: Thread | null } {
  return e.type === "thread:deleted" ? { messageId: e.gone.starterMessageId, thread: null } : { messageId: e.thread.starterMessageId, thread: e.thread };
}

/**
 * What the UI offers (only to show or hide; the server decides). `bits` = the user's bits in the PARENT channel, which
 * are the thread's. Rename / archive / delete: the creator or MANAGE_MESSAGES. Posting: SEND_MESSAGES and not archived.
 */
export function threadRights(bits: number, thread: Pick<Thread, "createdById" | "archived">, myId: string | undefined) {
  const send = hasPermission(bits, Permission.VIEW_CHANNEL) && hasPermission(bits, Permission.SEND_MESSAGES);
  return { manage: (!!myId && thread.createdById === myId) || hasPermission(bits, Permission.MANAGE_MESSAGES), post: send && !thread.archived };
}

/** "Tạo luồng" on a message: only in a channel (never inside a thread), when it has no thread yet and the user may write. */
export const canStartThread = ({ inThread, hasThread, canSend }: { inThread: boolean; hasThread: boolean; canSend: boolean }) => !inThread && !hasThread && canSend;

const clock = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("vi-VN", { day: "numeric", month: "numeric" });
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** The starter message's chip: "N trả lời, hoạt động lúc 14:05" (a date instead of the time before today). */
export function threadChip(t: Pick<Thread, "messageCount" | "lastMessageAt" | "createdAt">, now = new Date()): { key: "thread.chip" | "thread.chipEmpty"; vars: Record<string, string> } {
  const at = new Date(activity(t as Thread));
  const time = sameDay(at, now) ? clock.format(at) : dayMonth.format(at);
  return t.messageCount === 0 ? { key: "thread.chipEmpty", vars: { time } } : { key: "thread.chip", vars: { count: String(t.messageCount), time } };
}

/** A default name from the starter's text: its first line, at most 40 characters (the user can change it). */
export const suggestName = (content: string, fallback: string) => {
  const line = content.split("\n").find((l) => l.trim())?.trim() ?? "";
  const chars = [...line];
  return chars.length ? (chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : line) : fallback;
};

export type PanelChange = "deleted" | null;

/**
 * The side panel: at most one open thread, next to its parent channel. Not saved (a restart starts closed). Live
 * events keep the copy current; a delete closes it and says so, so the caller can tell the user.
 */
export function createThreadPanel() {
  const store = createStore<{ thread: Thread | null }>(() => ({ thread: null }));
  const close = () => {
    if (store.getState().thread) store.setState({ thread: null });
  };
  return {
    store,
    open: (thread: Thread) => store.setState({ thread }),
    close,
    apply(e: ThreadEvent): PanelChange {
      const open = store.getState().thread;
      if (!open || open.id !== idOf(e)) return null;
      if (e.type === "thread:deleted") {
        close();
        return "deleted";
      }
      store.setState({ thread: e.thread });
      return null;
    },
    /** The channel on screen changed: a thread of another channel (or of none) closes. */
    follow(channelId: string | null) {
      if (store.getState().thread?.parentChannelId !== channelId) close();
    },
  };
}
export type ThreadPanel = ReturnType<typeof createThreadPanel>;
