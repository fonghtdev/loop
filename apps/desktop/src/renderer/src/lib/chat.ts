import { createStore } from "zustand/vanilla";
import { ApiError, type AuthClient } from "./auth-client";
import type { ReadyAttachment } from "./attachment-queue";
import { messagesPath, type ConvKey } from "./conversation";
import { compareSeq } from "./seq";

export type Attachment = { id: string; filename: string; contentType: string; size: number; url: string };
/** A message as the server sends it (REST and `message:*` / `dm:message:*` events): a guild message or a DM one. */
export type Message = {
  id: string;
  channelId: string | null;
  dmChannelId: string | null;
  author: { id: string; username: string };
  content: string;
  createdAt: string;
  editedAt: string | null;
  seq: string;
  attachments: Attachment[];
};
/** A message typed here and not yet confirmed by the server. Its text and files are kept until it is sent or removed. */
export type Pending = { tempId: string; content: string; attachments: ReadyAttachment[]; status: "sending" | "failed"; createdAt: string };

export type ConvChat = {
  /** Ascending by seq, unique ids. */
  messages: Message[];
  pending: Pending[];
  status: "idle" | "loading" | "ready" | "error";
  /** The oldest message is loaded (a page came back shorter than asked). */
  reachedStart: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  /** The server says we cannot see this conversation (lost VIEW, deleted, not a DM member). */
  unavailable: boolean;
  /** When a DM send was refused with 403 "Not friends" (the composer closes until the friends list says otherwise). */
  forbiddenAt: number | null;
};

export const PAGE_SIZE = 50;
const CATCH_UP_PAGE = 100; // the server's maximum
export const EMPTY_CONV: ConvChat = {
  messages: [],
  pending: [],
  status: "idle",
  reachedStart: false,
  loadingOlder: false,
  olderFailed: false,
  unavailable: false,
  forbiddenAt: null,
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

const sameFiles = (p: Pending, m: Message) =>
  p.attachments.length === m.attachments.length && p.attachments.every((a) => m.attachments.some((x) => x.id === a.id));

/**
 * Our own message came back on the socket before the POST answered: drop the pending copy it confirms (same
 * text and same attachment ids, still sending) so the message never shows twice. The POST's answer then only
 * merges (a no-op). Also what makes the sender's own DM echo harmless.
 */
export function dropEchoedPending(pending: Pending[], m: Message, myId: string | undefined): Pending[] {
  if (m.author.id !== myId) return pending;
  const i = pending.findIndex((p) => p.status === "sending" && p.content === m.content && sameFiles(p, m));
  return i === -1 ? pending : pending.filter((_, j) => j !== i);
}

/** A pending message leaves the list for good: its local previews are freed. */
function release(p: Pending | undefined) {
  p?.attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
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

type Deps = {
  request: AuthClient["request"];
  myId: () => string | undefined;
  newId?: () => string;
  /** A DM send was refused with 403: the friendship is gone (or someone blocked), so the friends list is stale. */
  onForbidden?: () => void;
};
export type LiveEvent = { type: "message:new" | "message:update"; message: Message } | { type: "message:delete"; id: string };
export type Outgoing = { content: string; attachments: ReadyAttachment[] };

/**
 * The message store of the open conversation, a guild channel or a DM (Zustand, outside React so the socket
 * layer can feed it). One store for both kinds: lists are keyed by `ConvKey`, and only the REST path differs.
 * REST is the source of truth for history and writes; socket events and catch-up pages merge into the same list.
 */
export function createChat({ request, myId, newId = () => crypto.randomUUID(), onForbidden }: Deps) {
  const store = createStore<{ convs: Record<string, ConvChat> }>(() => ({ convs: {} }));
  const loads = new Map<string, Promise<void>>();
  const get = (key: ConvKey) => store.getState().convs[key] ?? EMPTY_CONV;
  const patch = (key: ConvKey, fn: (c: ConvChat) => Partial<ConvChat>) =>
    store.setState((s) => {
      const c = s.convs[key] ?? EMPTY_CONV;
      return { convs: { ...s.convs, [key]: { ...c, ...fn(c) } } };
    });
  const fetchPage = async (key: ConvKey, query: string) => (await request<{ messages: Message[] }>("GET", `${messagesPath(key)}?${query}`)).messages;
  const lostAccess = (key: ConvKey, e: unknown) => {
    if (e instanceof ApiError && e.status === 404) patch(key, () => ({ unavailable: true }));
  };
  const withoutPending = (c: ConvChat, tempId: string) => {
    release(c.pending.find((x) => x.tempId === tempId));
    return c.pending.filter((x) => x.tempId !== tempId);
  };

  async function post(key: ConvKey, p: Pending) {
    try {
      const attachmentIds = p.attachments.map((a) => a.id);
      const m = await request<Message>("POST", messagesPath(key), { content: p.content, ...(attachmentIds.length && { attachmentIds }) });
      patch(key, (c) => ({ pending: withoutPending(c, p.tempId), messages: mergeMessages(c.messages, [m]) }));
    } catch (e) {
      patch(key, (c) => ({ pending: c.pending.map((x) => (x.tempId === p.tempId ? { ...x, status: "failed" as const } : x)) }));
      lostAccess(key, e);
      if (e instanceof ApiError && e.status === 403 && key.startsWith("dm:")) {
        patch(key, () => ({ forbiddenAt: Date.now() }));
        onForbidden?.();
      }
    }
  }

  return {
    store,
    get,
    /** Newest page; live events that arrive meanwhile are merged, not overwritten. */
    loadLatest(key: ConvKey) {
      patch(key, () => ({ ...EMPTY_CONV, pending: get(key).pending, forbiddenAt: get(key).forbiddenAt, status: "loading" }));
      const load = (async () => {
        try {
          const page = await fetchPage(key, `limit=${PAGE_SIZE}`);
          patch(key, (c) => ({ status: "ready", messages: mergeMessages(c.messages, page), reachedStart: page.length < PAGE_SIZE }));
        } catch (e) {
          patch(key, () => ({ status: "error" }));
          lostAccess(key, e);
        } finally {
          loads.delete(key);
        }
      })();
      loads.set(key, load);
      return load;
    },
    async loadOlder(key: ConvKey) {
      const c = get(key);
      if (c.status !== "ready" || c.loadingOlder || c.reachedStart || !c.messages.length) return;
      patch(key, () => ({ loadingOlder: true, olderFailed: false }));
      try {
        const page = await fetchPage(key, `before=${c.messages[0].seq}&limit=${PAGE_SIZE}`);
        patch(key, (x) => ({ messages: mergeMessages(x.messages, page), reachedStart: page.length < PAGE_SIZE, loadingOlder: false }));
      } catch (e) {
        patch(key, () => ({ loadingOlder: false, olderFailed: true }));
        lostAccess(key, e);
      }
    },
    /**
     * After every successful subscribe (first one and each reconnect; a DM has no subscribe, it is called on
     * connect): fetch what was posted while we were not listening. Waits for an initial load in flight, whose
     * page may predate the subscription.
     */
    async catchUp(key: ConvKey) {
      await loads.get(key);
      const c = get(key);
      const last = c.messages[c.messages.length - 1];
      if (c.status !== "ready" || !last) return;
      try {
        const missed = await fetchAllAfter((after, limit) => fetchPage(key, `after=${after}&limit=${limit}`), last.seq);
        patch(key, (x) => ({ messages: mergeMessages(x.messages, missed) }));
      } catch (e) {
        lostAccess(key, e);
      }
    },
    receive(key: ConvKey, e: LiveEvent) {
      if (e.type === "message:delete") return patch(key, (c) => ({ messages: applyDelete(c.messages, e.id) }));
      if (e.type === "message:update") return patch(key, (c) => ({ messages: applyUpdate(c.messages, e.message) }));
      const m = e.message;
      patch(key, (c) => {
        const pending = dropEchoedPending(c.pending, m, myId());
        c.pending.filter((p) => !pending.includes(p)).forEach(release);
        return { messages: mergeMessages(c.messages, [m]), pending };
      });
    },
    /** Optimistic: shows at once as pending; on failure it stays (text and files kept) with retry/remove. */
    send(key: ConvKey, { content, attachments }: Outgoing) {
      const p: Pending = { tempId: newId(), content, attachments, status: "sending", createdAt: new Date().toISOString() };
      patch(key, (c) => ({ pending: [...c.pending, p] }));
      return post(key, p);
    },
    retry(key: ConvKey, tempId: string) {
      const p = get(key).pending.find((x) => x.tempId === tempId);
      if (!p || p.status !== "failed") return;
      const again = { ...p, status: "sending" as const };
      patch(key, (c) => ({ pending: c.pending.map((x) => (x.tempId === tempId ? again : x)) }));
      return post(key, again);
    },
    discard(key: ConvKey, tempId: string) {
      patch(key, (c) => ({ pending: withoutPending(c, tempId) }));
    },
    /** Throws the ApiError for the caller to show. */
    async edit(key: ConvKey, id: string, content: string) {
      try {
        const m = await request<Message>("PATCH", `/messages/${id}`, { content });
        patch(key, (c) => ({ messages: applyUpdate(c.messages, m) }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) patch(key, (c) => ({ messages: applyDelete(c.messages, id) }));
        throw e;
      }
    },
    async remove(key: ConvKey, id: string) {
      try {
        await request("DELETE", `/messages/${id}`);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e; // already gone (or hidden): drop it below
      }
      patch(key, (c) => ({ messages: applyDelete(c.messages, id) }));
    },
    markUnavailable(key: ConvKey) {
      patch(key, () => ({ unavailable: true }));
    },
    /** Leaving a conversation: its messages go (events for closed ones are not tracked), unsent text stays. */
    close(key: ConvKey) {
      patch(key, (c) => ({ ...EMPTY_CONV, pending: c.pending, forbiddenAt: c.forbiddenAt }));
    },
    reset() {
      loads.clear();
      Object.values(store.getState().convs).forEach((c) => c.pending.forEach(release));
      store.setState({ convs: {} });
    },
  };
}
