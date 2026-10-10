import { createStore } from "zustand/vanilla";
import { isConversationKey } from "../../../shared/notify";
import type { ConvKey } from "./conversation";
import { compareSeq } from "./seq";

/** The newest message of a conversation that has been seen: `seq` orders, `at` (server clock, ms) is for the DM list. */
type Seen = { seq: string; at: number };
/** What the unread logic needs to know about a message. */
export type Seeable = { id: string; seq: string; createdAt: string };

/** Persisted values stay small: the most recently read conversations win. */
const MAX_SEEN = 500;
/**
 * A DM is unread after a restart when its `lastMessageAt` is later than what we saw by more than this. Both sides
 * are SERVER times (we store the createdAt of the newest message seen), so skew only matters for the baseline;
 * ponytail: a baseline taken with the client clock can be off by the skew, upgrade = a server read-state endpoint.
 */
export const DM_MARGIN_MS = 2_000;

export type UnreadStorage = { read(userId: string): string | null; write(userId: string, value: string): void };
export type UnreadState = {
  /** Live unread messages per conversation (this session). */
  counts: Record<string, number>;
  /** DMs found unread by the list (after a restart / reconnect): shown as a dot, not a number. */
  dots: Record<string, true>;
};

const ms = (iso: string) => {
  const v = Date.parse(iso);
  return Number.isNaN(v) ? 0 : v;
};

/** A stored value back into shape; anything unexpected is dropped. */
export function parseSeen(raw: string | null): Record<string, Seen> {
  try {
    const v = JSON.parse(raw ?? "null");
    if (!v || typeof v !== "object") return {};
    const out: Record<string, Seen> = {};
    for (const [k, s] of Object.entries(v as Record<string, Seen>))
      if (isConversationKey(k) && s && typeof s.seq === "string" && /^\d+$/.test(s.seq) && typeof s.at === "number" && Number.isFinite(s.at)) out[k] = { seq: s.seq, at: s.at };
    return out;
  } catch {
    return {};
  }
}

/**
 * Unread tracking: pure bookkeeping, fed by the bindings in app.ts. A message counts only when it is someone else's,
 * newer than what was seen, and the conversation is not being read (open + window focused + list at the bottom).
 */
export function createUnread({ storage, now = Date.now }: { storage: UnreadStorage; now?: () => number }) {
  const store = createStore<UnreadState>(() => ({ counts: {}, dots: {} }));
  let userId: string | null = null;
  let seen: Record<string, Seen> = {};
  let ids: Record<string, Set<string>> = {}; // ids of the unread messages (dedupe; a delete removes its own)
  let newest: Record<string, Seeable> = {};
  let lastMessage: Record<string, number> = {}; // DM lastMessageAt from the list
  let view: { key: ConvKey | null; focused: boolean; pinned: boolean } = { key: null, focused: false, pinned: true };

  const reading = (key: string) => view.key === key && view.focused && view.pinned;
  const publish = () =>
    store.setState((s) => ({ counts: Object.fromEntries(Object.entries(ids).filter(([, v]) => v.size).map(([k, v]) => [k, v.size])), dots: s.dots }));
  const setDot = (key: string, on: boolean) => {
    if (!!store.getState().dots[key] === on) return;
    const dots = { ...store.getState().dots };
    if (on) dots[key] = true;
    else delete dots[key];
    store.setState({ dots });
  };
  const persist = () => {
    if (!userId) return;
    const kept = Object.entries(seen).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SEEN);
    seen = Object.fromEntries(kept);
    try {
      storage.write(userId, JSON.stringify(seen));
    } catch {
      // a lost preference is harmless
    }
  };

  function markRead(key: string, m?: Seeable) {
    const last = m ?? newest[key];
    const prev = seen[key];
    const seq = last && (!prev || compareSeq(last.seq, prev.seq) > 0) ? last.seq : (prev?.seq ?? "0");
    const at = Math.max(prev?.at ?? 0, last ? ms(last.createdAt) : (lastMessage[key] ?? now()));
    const changed = !prev || prev.seq !== seq || prev.at !== at;
    seen[key] = { seq, at };
    if (ids[key]?.size) {
      delete ids[key];
      publish();
    }
    setDot(key, false);
    if (changed) persist();
  }

  const alreadySeen = (key: string, m: Seeable) => !!seen[key] && compareSeq(m.seq, seen[key].seq) <= 0;

  return {
    store,
    /** A user signs in: their persisted marks are loaded, nothing of the previous user remains. */
    start(id: string) {
      this.reset();
      userId = id;
      try {
        seen = parseSeen(storage.read(id));
      } catch {
        seen = {};
      }
    },
    /** Sign-out: memory only; the persisted marks stay for the next sign-in of that user. */
    reset() {
      userId = null;
      seen = {};
      ids = {};
      newest = {};
      lastMessage = {};
      view = { key: null, focused: view.focused, pinned: true };
      store.setState({ counts: {}, dots: {} });
    },
    setFocused(focused: boolean) {
      if (view.focused === focused) return;
      view = { ...view, focused };
      if (view.key && reading(view.key)) markRead(view.key);
    },
    /** The conversation on screen (null = none). It starts pinned: a fresh list shows its end. */
    open(key: ConvKey | null) {
      view = { ...view, key, pinned: true };
      if (key && reading(key)) markRead(key);
    },
    setPinned(pinned: boolean) {
      if (view.pinned === pinned) return;
      view = { ...view, pinned };
      if (view.key && reading(view.key)) markRead(view.key);
    },
    /** A message of the open conversation was loaded (history): it is the newest known, and seen when reading. */
    observe(key: ConvKey, m: Seeable | undefined) {
      if (!m) return;
      if (!newest[key] || compareSeq(m.seq, newest[key].seq) > 0) newest[key] = m;
      if (reading(key)) markRead(key, m);
    },
    /** A new message arrived (socket or catch-up). Counted once, never when it is ours, seen already, or being read. */
    message(key: ConvKey, m: Seeable, authorId: string, myId: string | undefined) {
      if (!newest[key] || compareSeq(m.seq, newest[key].seq) > 0) newest[key] = m;
      if (authorId === myId || reading(key)) return markRead(key, m); // our own message / on screen: caught up
      if (alreadySeen(key, m)) return;
      (ids[key] ??= new Set()).add(m.id);
      publish();
    },
    deleted(key: ConvKey, id: string) {
      if (ids[key]?.delete(id)) publish();
    },
    /** The DM list (fresh or refetched): baseline for unknown DMs, a dot for those with newer activity than seen. */
    reconcileDms(dms: { id: string; lastMessageAt: string | null }[]) {
      let seeded = false;
      for (const dm of dms) {
        const key = `dm:${dm.id}`;
        const at = dm.lastMessageAt ? ms(dm.lastMessageAt) : 0;
        lastMessage[key] = at;
        if (!seen[key]) {
          seen[key] = { seq: "0", at: now() }; // first sight of this DM: what is there now is not "new"
          seeded = true;
        } else if (at > seen[key].at + DM_MARGIN_MS && !reading(key) && !ids[key]?.size) setDot(key, true);
        else if (at <= seen[key].at + DM_MARGIN_MS) setDot(key, false);
      }
      if (seeded) persist();
    },
  };
}
export type Unread = ReturnType<typeof createUnread>;

/** How many unread things a conversation shows: live messages, or 1 for a restart dot. */
export const unreadOf = (s: UnreadState, key: string) => s.counts[key] ?? (s.dots[key] ? 1 : 0);
const sumUnread = (s: UnreadState, only: (key: string) => boolean) => [...new Set([...Object.keys(s.counts), ...Object.keys(s.dots)])].filter(only).reduce((n, k) => n + unreadOf(s, k), 0);
export const dmTotal = (s: UnreadState) => sumUnread(s, (k) => k.startsWith("dm:"));
export const total = (s: UnreadState) => sumUnread(s, () => true);
/** "9+" past nine, "" for none: the rail badge. */
export const capped = (n: number) => (n <= 0 ? "" : n > 9 ? "9+" : String(n));
export const titleWith = (n: number) => (n > 0 ? `(${n}) Loop` : "Loop");
