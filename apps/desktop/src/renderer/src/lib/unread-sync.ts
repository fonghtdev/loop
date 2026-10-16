import type { UnreadResponse } from "@loop/shared";
import type { AuthClient } from "./auth-client";
import { parseKey, type ConvKey } from "./conversation";
import { compareSeq } from "./seq";

/** One PUT per conversation per this long, whatever the rate of messages being read. */
export const READ_PUT_MS = 2_000;
/** Refresh requests asked for within this window become one. */
const REFRESH_DEBOUNCE_MS = 400;

const readPath = (key: ConvKey) => {
  const { kind, id } = parseKey(key);
  return kind === "dm" ? `/dms/${id}/read` : `/channels/${id}/read`;
};

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const rows = (v: unknown) => (Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : []);

/** The answer of `GET /me/unread`, with anything malformed dropped. */
export function parseUnread(raw: unknown): UnreadResponse {
  const r = (raw ?? {}) as { channels?: unknown; dms?: unknown };
  return {
    channels: rows(r.channels).flatMap((c) =>
      typeof c.channelId === "string" && typeof c.guildId === "string" ? [{ channelId: c.channelId, guildId: c.guildId, unread: count(c.unread), mentions: count(c.mentions) }] : [],
    ),
    dms: rows(r.dms).flatMap((d) => (typeof d.dmChannelId === "string" ? [{ dmChannelId: d.dmChannelId, unread: count(d.unread), mentions: count(d.mentions) }] : [])),
  };
}

type Slot = { sentAt: number; sentSeq: string | null; pending: string | null; timer?: ReturnType<typeof setTimeout> };

/**
 * Talks to the server's read state: `mark` reports how far a conversation is read (at most one PUT per conversation per
 * 2 s: the first goes at once, later ones coalesce into one that carries the highest seq), `refresh` loads the
 * unread counts (requests close together become one; an answer that arrives after `cancel` is dropped).
 * Failures are swallowed: a missed PUT is repeated by the next one, a missed refresh by the next trigger.
 */
export function createUnreadSync({ request, apply, now = Date.now }: { request: AuthClient["request"]; apply: (r: UnreadResponse) => void; now?: () => number }) {
  const slots = new Map<ConvKey, Slot>();
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastLoaded = 0;
  let inFlight = false;
  let again = false;

  function flush(key: ConvKey, slot: Slot) {
    slot.timer = undefined;
    const seq = slot.pending;
    slot.pending = null;
    if (!seq || (slot.sentSeq && compareSeq(seq, slot.sentSeq) <= 0)) return;
    const previous = slot.sentSeq;
    slot.sentAt = now();
    slot.sentSeq = seq;
    request("PUT", readPath(key), { seq }).catch(() => {
      if (slot.sentSeq === seq) slot.sentSeq = previous; // so the next mark sends again
    });
  }

  async function load() {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const mine = generation;
    try {
      const answer = parseUnread(await request("GET", "/me/unread"));
      if (mine === generation) {
        lastLoaded = now();
        apply(answer);
      }
    } catch {
      // the next trigger asks again
    } finally {
      inFlight = false;
      if (again) {
        again = false;
        sync.refresh();
      }
    }
  }

  const sync = {
    mark(key: ConvKey, seq: string) {
      const slot = slots.get(key) ?? { sentAt: 0, sentSeq: null, pending: null };
      slots.set(key, slot);
      if (!slot.pending || compareSeq(seq, slot.pending) > 0) slot.pending = seq;
      if (slot.timer) return;
      const wait = slot.sentAt + READ_PUT_MS - now();
      if (wait <= 0) flush(key, slot);
      else slot.timer = setTimeout(() => flush(key, slot), wait);
    },
    /** `minGapMs`: skip when the counts were loaded that recently (for triggers that fire often, like window focus). */
    refresh(minGapMs = 0) {
      if (minGapMs && now() - lastLoaded < minGapMs) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    },
    /** Sign-out: nothing pending is sent, nothing in flight is applied. */
    cancel() {
      generation++;
      clearTimeout(timer);
      for (const slot of slots.values()) clearTimeout(slot.timer);
      slots.clear();
      again = false;
      lastLoaded = 0;
    },
  };
  return sync;
}
export type UnreadSync = ReturnType<typeof createUnreadSync>;
