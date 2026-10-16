import type { UnreadResponse } from "@loop/shared";
import { createStore } from "zustand/vanilla";
import { channelKey, dmKey, type ConvKey } from "./conversation";
import type { Slot } from "./realtime";
import { compareSeq } from "./seq";

/** What the unread logic needs to know about a message. */
export type Seeable = { id: string; seq: string };

export type UnreadState = {
  /** Unread messages per conversation: the server's count at the last sync plus what arrived live since. */
  counts: Record<string, number>;
  /** The part of `counts` that mentions me (or @everyone), shown as a red badge. */
  mentions: Record<string, number>;
  /** The same per server (the rail badge); a mention with no known server is counted only per conversation. */
  guildMentions: Record<string, number>;
  /**
   * Unread messages per server, from the server's counts only (so a server never opened this session still shows):
   * live messages of other servers are not delivered, a refresh (`seed`) picks them up.
   */
  guildUnread: Record<string, number>;
};
/** Where a mention happened, so the rail can badge the server. */
export type MentionInfo = { guildId: string | null };

/** The server's count for one conversation (`GET /me/unread`), taken as the starting point until the next sync. */
type Base = { unread: number; mentions: number; guildId: string | null };
type Mention = { guildId: string | null; seq: string };

/**
 * Unread tracking: pure bookkeeping, fed by the bindings in app.ts. The server owns the read pointer: `seed` loads its
 * counts (all servers, all devices), `report` tells it how far this device has read, and `serverRead` applies a read
 * done on another device. In between, a message counts only when it is someone else's, newer than what was read, and the
 * conversation is not being read (open + window focused + list at the bottom).
 */
export function createUnread({ report }: { report?: (key: ConvKey, seq: string) => void } = {}) {
  const store = createStore<UnreadState>(() => ({ counts: {}, mentions: {}, guildMentions: {}, guildUnread: {} }));
  let base: Record<string, Base> = {};
  let ids: Record<string, Map<string, string>> = {}; // live unread messages: id -> seq (dedupe; a delete removes its own)
  let mentionIds: Record<string, Map<string, Mention>> = {}; // live unread mentions
  let newest: Record<string, Seeable> = {};
  let readUpTo: Record<string, string> = {}; // the highest seq known to be read, here or on another device
  // what is on screen, per slot (the main area, and the side panel of an open thread), each with its own scroll state
  type Pane = { key: ConvKey | null; pinned: boolean };
  const closed: Pane = { key: null, pinned: true };
  let focused = false;
  let panes: Record<Slot, Pane> = { main: closed, side: closed };

  const reading = (key: string) => focused && Object.values(panes).some((p) => p.key === key && p.pinned);
  const markReadIfReading = () => {
    for (const { key } of Object.values(panes)) if (key && reading(key)) markRead(key);
  };
  const publish = () => {
    const counts: Record<string, number> = {};
    const mentions: Record<string, number> = {};
    const guildMentions: Record<string, number> = {};
    const guildUnread: Record<string, number> = {};
    const add = (to: Record<string, number>, key: string, n: number) => n > 0 && (to[key] = (to[key] ?? 0) + n);
    for (const [key, b] of Object.entries(base)) {
      add(counts, key, b.unread);
      add(mentions, key, b.mentions);
      if (b.guildId) {
        add(guildMentions, b.guildId, b.mentions);
        add(guildUnread, b.guildId, b.unread);
      }
    }
    for (const [key, m] of Object.entries(ids)) add(counts, key, m.size);
    for (const [key, m] of Object.entries(mentionIds))
      for (const { guildId } of m.values()) {
        add(mentions, key, 1);
        if (guildId) add(guildMentions, guildId, 1);
      }
    store.setState({ counts, mentions, guildMentions, guildUnread });
  };
  const forget = (key: string) => {
    const had = !!(base[key] || ids[key]?.size || mentionIds[key]?.size);
    delete base[key];
    delete ids[key];
    delete mentionIds[key];
    return had;
  };

  /** Read up to `m` (default: the newest message known): the badge goes, the server is told. */
  function markRead(key: ConvKey, m?: Seeable) {
    const last = m ?? newest[key];
    if (last && compareSeq(last.seq, readUpTo[key] ?? "0") > 0) {
      readUpTo[key] = last.seq;
      report?.(key, last.seq);
    }
    if (forget(key)) publish();
  }

  const alreadyRead = (key: string, m: Seeable) => !!readUpTo[key] && compareSeq(m.seq, readUpTo[key]) <= 0;

  return {
    store,
    /** A user signs in: nothing of the previous user remains. */
    start() {
      this.reset();
    },
    /** Sign-out: memory only. */
    reset() {
      base = {};
      ids = {};
      mentionIds = {};
      newest = {};
      readUpTo = {};
      panes = { main: closed, side: closed };
      store.setState({ counts: {}, mentions: {}, guildMentions: {}, guildUnread: {} });
    },
    setFocused(next: boolean) {
      if (focused === next) return;
      focused = next;
      markReadIfReading();
    },
    /** The conversation on screen in `slot` (null = none). It starts pinned: a fresh list shows its end. */
    open(key: ConvKey | null, slot: Slot = "main") {
      panes = { ...panes, [slot]: { key, pinned: true } };
      if (key && reading(key)) markRead(key);
    },
    setPinned(pinned: boolean, slot: Slot = "main") {
      if (panes[slot].pinned === pinned) return;
      panes = { ...panes, [slot]: { ...panes[slot], pinned } };
      markReadIfReading();
    },
    /** A message of the open conversation was loaded (history): it is the newest known, and seen when reading. */
    observe(key: ConvKey, m: Seeable | undefined) {
      if (!m) return;
      if (!newest[key] || compareSeq(m.seq, newest[key].seq) > 0) newest[key] = m;
      if (reading(key)) markRead(key, m);
    },
    /**
     * A new message arrived live. Counted once (by id, so the same message through two channels is one), never when
     * it is ours, read already, or being read. `mention`: it names me, so it also counts as a mention.
     */
    message(key: ConvKey, m: Seeable, authorId: string, myId: string | undefined, mention?: MentionInfo) {
      if (!newest[key] || compareSeq(m.seq, newest[key].seq) > 0) newest[key] = m;
      if (authorId === myId || reading(key)) return markRead(key, m); // our own message / on screen: caught up
      if (alreadyRead(key, m)) return;
      (ids[key] ??= new Map()).set(m.id, m.seq);
      if (mention) (mentionIds[key] ??= new Map()).set(m.id, { guildId: mention.guildId, seq: m.seq });
      publish();
    },
    deleted(key: ConvKey, id: string) {
      const gone = [ids[key]?.delete(id), mentionIds[key]?.delete(id)].some(Boolean);
      if (gone) publish();
    },
    /**
     * The server's counts (login, reconnect, switching server): they replace everything counted so far, since they
     * include every message up to now. The conversation being read stays at zero.
     */
    seed({ channels, dms }: UnreadResponse) {
      base = {};
      ids = {};
      mentionIds = {};
      for (const c of channels) if (!reading(channelKey(c.channelId))) base[channelKey(c.channelId)] = { unread: c.unread, mentions: c.mentions, guildId: c.guildId };
      for (const d of dms) if (!reading(dmKey(d.dmChannelId))) base[dmKey(d.dmChannelId)] = { unread: d.unread, mentions: d.mentions, guildId: null };
      publish();
    },
    /** Another device (or this one, echoed) read the conversation up to `seq`: what it covers is no longer unread. */
    serverRead(key: ConvKey, seq: string) {
      if (compareSeq(seq, readUpTo[key] ?? "0") > 0) readUpTo[key] = seq;
      const covered = <V>(live: Map<string, V> | undefined, seqOf: (v: V) => string) =>
        [...(live ?? [])].filter(([, v]) => compareSeq(seqOf(v), seq) <= 0).map(([id]) => live!.delete(id)).length > 0;
      const changed = [key in base && delete base[key], covered(ids[key], (v) => v), covered(mentionIds[key], (v) => v.seq)].some(Boolean);
      if (changed) publish();
    },
  };
}
export type Unread = ReturnType<typeof createUnread>;

/** How many unread messages a conversation shows. */
export const unreadOf = (s: UnreadState, key: string) => s.counts[key] ?? 0;
const sumUnread = (s: UnreadState, only: (key: string) => boolean) => Object.keys(s.counts).filter(only).reduce((n, k) => n + unreadOf(s, k), 0);
/** Unread mentions of a conversation (a red badge on the channel row). */
export const mentionsOf = (s: UnreadState, key: string) => s.mentions[key] ?? 0;
export const dmTotal = (s: UnreadState) => sumUnread(s, (k) => k.startsWith("dm:"));
export const total = (s: UnreadState) => sumUnread(s, () => true);
/** What the rail shows on a server: the red mention badge, else a dot when anything in it is unread, else nothing. */
export const railMark = (s: UnreadState, guildId: string): "mentions" | "dot" | null => ((s.guildMentions[guildId] ?? 0) > 0 ? "mentions" : (s.guildUnread[guildId] ?? 0) > 0 ? "dot" : null);
/** "9+" past nine, "" for none: the rail badge. */
export const capped = (n: number) => (n <= 0 ? "" : n > 9 ? "9+" : String(n));
export const titleWith = (n: number) => (n > 0 ? `(${n}) Loop` : "Loop");
