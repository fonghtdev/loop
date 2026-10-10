import { createStore } from "zustand/vanilla";
import { ApiError, type AuthClient } from "./auth-client";
import { compareSeq } from "./seq";

/** A guild message as the server sends it (REST and `message:*` events). Attachments are ignored until 9c. */
export type Message = {
  id: string;
  channelId: string | null;
  author: { id: string; username: string };
  content: string;
  createdAt: string;
  editedAt: string | null;
  seq: string;
};
/** A message typed here and not yet confirmed by the server. Its text is kept until it is sent or removed. */
export type Pending = { tempId: string; content: string; status: "sending" | "failed"; createdAt: string };

export type ChannelChat = {
  /** Ascending by seq, unique ids. */
  messages: Message[];
  pending: Pending[];
  status: "idle" | "loading" | "ready" | "error";
  /** The oldest message is loaded (a page came back shorter than asked). */
  reachedStart: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  /** The server says we cannot see this channel (lost VIEW, deleted). */
  unavailable: boolean;
};

export const PAGE_SIZE = 50;
const CATCH_UP_PAGE = 100; // the server's maximum
export const EMPTY_CHANNEL: ChannelChat = {
  messages: [],
  pending: [],
  status: "idle",
  reachedStart: false,
  loadingOlder: false,
  olderFailed: false,
  unavailable: false,
};

const lastChange = (m: Message) => m.editedAt ?? m.createdAt;

/**
 * History pages and live events into one list: deduped by id (the sender gets its own `message:new` too, and a
 * catch-up page can overlap what the socket delivered), sorted by seq. Of two copies the later-edited one wins,
 * so a history page fetched before an edit cannot undo it.
 */
export function mergeMessages(list: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return list;
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) {
    const old = byId.get(m.id);
    if (!old || lastChange(m) >= lastChange(old)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => compareSeq(a.seq, b.seq));
}

/** An edit only replaces a message we hold (one outside the loaded window is not added). */
export const applyUpdate = (list: Message[], m: Message) => (list.some((x) => x.id === m.id) ? mergeMessages(list, [m]) : list);
export const applyDelete = (list: Message[], id: string) => list.filter((m) => m.id !== id);

/**
 * Our own message came back on the socket before the POST answered: drop the pending copy it confirms (same
 * text, still sending) so the message never shows twice. The POST's answer then only merges (a no-op).
 */
export function dropEchoedPending(pending: Pending[], m: Message, myId: string | undefined): Pending[] {
  if (m.author.id !== myId) return pending;
  const i = pending.findIndex((p) => p.status === "sending" && p.content === m.content);
  return i === -1 ? pending : pending.filter((_, j) => j !== i);
}

/** Reconnect catch-up: every message after `after`, paging on until a page comes back short. */
export async function fetchAllAfter(fetchPage: (after: string, limit: number) => Promise<Message[]>, after: string): Promise<Message[]> {
  const all: Message[] = [];
  let cursor = after;
  // ponytail: pages through any gap; a very long offline period means many requests (upgrade = reload latest past N pages)
  for (;;) {
    const page = await fetchPage(cursor, CATCH_UP_PAGE);
    all.push(...page);
    if (page.length < CATCH_UP_PAGE) return all;
    cursor = page[page.length - 1].seq;
  }
}

type Deps = { request: AuthClient["request"]; myId: () => string | undefined; newId?: () => string };
export type LiveEvent = { type: "message:new" | "message:update"; message: Message } | { type: "message:delete"; id: string };

/**
 * The message store of the open channel (Zustand, outside React so the socket layer can feed it). REST is the
 * source of truth for history and writes; socket events and catch-up pages merge into the same list.
 */
export function createChat({ request, myId, newId = () => crypto.randomUUID() }: Deps) {
  const store = createStore<{ channels: Record<string, ChannelChat> }>(() => ({ channels: {} }));
  const loads = new Map<string, Promise<void>>();
  const get = (id: string) => store.getState().channels[id] ?? EMPTY_CHANNEL;
  const patch = (id: string, fn: (c: ChannelChat) => Partial<ChannelChat>) =>
    store.setState((s) => {
      const c = s.channels[id] ?? EMPTY_CHANNEL;
      return { channels: { ...s.channels, [id]: { ...c, ...fn(c) } } };
    });
  const fetchPage = async (channelId: string, query: string) =>
    (await request<{ messages: Message[] }>("GET", `/channels/${channelId}/messages?${query}`)).messages;
  const lostAccess = (channelId: string, e: unknown) => {
    if (e instanceof ApiError && e.status === 404) patch(channelId, () => ({ unavailable: true }));
  };

  async function post(channelId: string, p: Pending) {
    try {
      const m = await request<Message>("POST", `/channels/${channelId}/messages`, { content: p.content });
      patch(channelId, (c) => ({ pending: c.pending.filter((x) => x.tempId !== p.tempId), messages: mergeMessages(c.messages, [m]) }));
    } catch (e) {
      patch(channelId, (c) => ({ pending: c.pending.map((x) => (x.tempId === p.tempId ? { ...x, status: "failed" as const } : x)) }));
      lostAccess(channelId, e);
    }
  }

  return {
    store,
    get,
    /** Newest page; live events that arrive meanwhile are merged, not overwritten. */
    loadLatest(channelId: string) {
      patch(channelId, () => ({ ...EMPTY_CHANNEL, pending: get(channelId).pending, status: "loading" }));
      const load = (async () => {
        try {
          const page = await fetchPage(channelId, `limit=${PAGE_SIZE}`);
          patch(channelId, (c) => ({ status: "ready", messages: mergeMessages(c.messages, page), reachedStart: page.length < PAGE_SIZE }));
        } catch (e) {
          patch(channelId, () => ({ status: "error" }));
          lostAccess(channelId, e);
        } finally {
          loads.delete(channelId);
        }
      })();
      loads.set(channelId, load);
      return load;
    },
    async loadOlder(channelId: string) {
      const c = get(channelId);
      if (c.status !== "ready" || c.loadingOlder || c.reachedStart || !c.messages.length) return;
      patch(channelId, () => ({ loadingOlder: true, olderFailed: false }));
      try {
        const page = await fetchPage(channelId, `before=${c.messages[0].seq}&limit=${PAGE_SIZE}`);
        patch(channelId, (x) => ({ messages: mergeMessages(x.messages, page), reachedStart: page.length < PAGE_SIZE, loadingOlder: false }));
      } catch (e) {
        patch(channelId, () => ({ loadingOlder: false, olderFailed: true }));
        lostAccess(channelId, e);
      }
    },
    /**
     * After every successful subscribe (first one and each reconnect): fetch what was posted while we were not
     * in the room. Waits for an initial load in flight, whose page may predate the subscription.
     */
    async catchUp(channelId: string) {
      await loads.get(channelId);
      const c = get(channelId);
      const last = c.messages[c.messages.length - 1];
      if (c.status !== "ready" || !last) return;
      try {
        const missed = await fetchAllAfter((after, limit) => fetchPage(channelId, `after=${after}&limit=${limit}`), last.seq);
        patch(channelId, (x) => ({ messages: mergeMessages(x.messages, missed) }));
      } catch (e) {
        lostAccess(channelId, e);
      }
    },
    receive(channelId: string, e: LiveEvent) {
      if (e.type === "message:delete") return patch(channelId, (c) => ({ messages: applyDelete(c.messages, e.id) }));
      if (e.type === "message:update") return patch(channelId, (c) => ({ messages: applyUpdate(c.messages, e.message) }));
      const m = e.message;
      patch(channelId, (c) => ({ messages: mergeMessages(c.messages, [m]), pending: dropEchoedPending(c.pending, m, myId()) }));
    },
    /** Optimistic: shows at once as pending; on failure it stays (text kept) with retry/remove. */
    send(channelId: string, content: string) {
      const p: Pending = { tempId: newId(), content, status: "sending", createdAt: new Date().toISOString() };
      patch(channelId, (c) => ({ pending: [...c.pending, p] }));
      return post(channelId, p);
    },
    retry(channelId: string, tempId: string) {
      const p = get(channelId).pending.find((x) => x.tempId === tempId);
      if (!p || p.status !== "failed") return;
      const again = { ...p, status: "sending" as const };
      patch(channelId, (c) => ({ pending: c.pending.map((x) => (x.tempId === tempId ? again : x)) }));
      return post(channelId, again);
    },
    discard(channelId: string, tempId: string) {
      patch(channelId, (c) => ({ pending: c.pending.filter((x) => x.tempId !== tempId) }));
    },
    /** Throws the ApiError for the caller to show. */
    async edit(channelId: string, id: string, content: string) {
      try {
        const m = await request<Message>("PATCH", `/messages/${id}`, { content });
        patch(channelId, (c) => ({ messages: applyUpdate(c.messages, m) }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) patch(channelId, (c) => ({ messages: applyDelete(c.messages, id) }));
        throw e;
      }
    },
    async remove(channelId: string, id: string) {
      try {
        await request("DELETE", `/messages/${id}`);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e; // already gone (or hidden): drop it below
      }
      patch(channelId, (c) => ({ messages: applyDelete(c.messages, id) }));
    },
    markUnavailable(channelId: string) {
      patch(channelId, () => ({ unavailable: true }));
    },
    /** Leaving a channel: its messages go (events for closed channels are not tracked), unsent text stays. */
    close(channelId: string) {
      patch(channelId, (c) => ({ ...EMPTY_CHANNEL, pending: c.pending }));
    },
    reset() {
      loads.clear();
      store.setState({ channels: {} });
    },
  };
}
