import { foldText, guildSearchQuerySchema, type SearchResponse, searchTerms } from "@loop/shared";
import { createStore } from "zustand/vanilla";
import type { AuthClient } from "./auth-client";
import type { Message } from "./chat";
import { channelKey, dmKey, type ConvKey } from "./conversation";

export type SearchScope = { kind: "guild"; guildId: string } | { kind: "dm"; dmId: string };

/** Ctrl+F / Cmd+F (not with Shift or Alt): focus the search box of the chat. */
export const isFindShortcut = (e: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }) =>
  (!!e.ctrlKey || !!e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";

/**
 * The text to search, trimmed, or null when the server would refuse it (empty, over 100 characters) or when it holds no
 * word to look for (only punctuation).
 */
export function normalizeQuery(raw: string): string | null {
  const q = raw.trim();
  return guildSearchQuerySchema.safeParse({ q }).success && searchTerms(q).length > 0 ? q : null;
}

export function searchPath(scope: SearchScope, q: string, before?: string) {
  const params = new URLSearchParams({ q, ...(before && { before }) });
  return scope.kind === "dm" ? `/dms/${scope.dmId}/messages/search?${params}` : `/guilds/${scope.guildId}/messages/search?${params}`;
}

/** The conversation a result belongs to. */
export const hitKey = (m: Pick<Message, "channelId" | "dmChannelId">): ConvKey => (m.dmChannelId ? dmKey(m.dmChannelId) : channelKey(m.channelId!));

/** One folding for search highlights, AutoMod and the server's `loop_fold` (shared). */
export { foldText };

export type Part = { text: string; hit: boolean };

/** `text` cut into plain and matching parts (text only, never HTML): a term matches at the start of a word, accents and case ignored. */
export function highlight(text: string, query: string): Part[] {
  const source = text.normalize("NFC");
  const terms = [...new Set(searchTerms(query).map(foldText))].sort((a, b) => b.length - a.length);
  if (!terms.length || !source) return source ? [{ text: source, hit: false }] : [];
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})`, "gu");
  const parts: Part[] = [];
  let at = 0;
  for (const m of foldText(source).matchAll(pattern)) {
    if (m.index > at) parts.push({ text: source.slice(at, m.index), hit: false });
    parts.push({ text: source.slice(m.index, m.index + m[0].length), hit: true });
    at = m.index + m[0].length;
  }
  if (at < source.length) parts.push({ text: source.slice(at), hit: false });
  return parts;
}

const SNIPPET_CHARS = 160;
const LEAD_CHARS = 40;

/** A window of the message around the first match (the whole text when it is short), highlighted; "..." marks a cut. */
export function snippet(content: string, query: string, max = SNIPPET_CHARS): Part[] {
  const parts = highlight(content, query);
  const flat = parts.map((p) => p.text).join("");
  if ([...flat].length <= max) return parts;
  const firstHit = parts.findIndex((p) => p.hit);
  const hitAt = firstHit < 0 ? 0 : parts.slice(0, firstHit).reduce((n, p) => n + p.text.length, 0);
  const from = Math.max(0, hitAt - LEAD_CHARS);
  const to = Math.min(flat.length, from + max);
  const cut: Part[] = [];
  let pos = 0;
  for (const p of parts) {
    const a = Math.max(pos, from);
    const b = Math.min(pos + p.text.length, to);
    if (b > a) cut.push({ text: p.text.slice(a - pos, b - pos), hit: p.hit });
    pos += p.text.length;
  }
  if (from > 0) cut.unshift({ text: "...", hit: false });
  if (to < flat.length) cut.push({ text: "...", hit: false });
  return cut;
}

/**
 * What choosing a result does. The message can only be scrolled to when its conversation is open and holds it. Other
 * conversations are opened first and the scroll is tried when they have loaded (`pendingJump`); the API has no "around
 * this message", so a message older than the loaded window is not reachable and the user is told so.
 */
export function jumpPlan(hitConv: ConvKey, open: ConvKey | null, loaded: boolean): "scroll" | "outside" | "open" {
  if (hitConv !== open) return "open";
  return loaded ? "scroll" : "outside";
}

/** A jump waiting for its conversation to load: set by a search result, taken by the conversation once it is ready. */
export function createPendingJump() {
  let pending: { key: ConvKey; id: string } | null = null;
  return {
    set(key: ConvKey, id: string) {
      pending = { key, id };
    },
    /** The message id to scroll to in `key`, once; null when nothing waits there. */
    take(key: ConvKey): string | null {
      if (pending?.key !== key) return null;
      const { id } = pending;
      pending = null;
      return id;
    },
    clear() {
      pending = null;
    },
  };
}
export const pendingJump = createPendingJump();

export type SearchState = { query: string; status: "idle" | "loading" | "ready" | "error"; results: Message[]; hasMore: boolean; loadingMore: boolean; moreFailed: boolean };
const IDLE: SearchState = { query: "", status: "idle", results: [], hasMore: false, loadingMore: false, moreFailed: false };
const TYPING_PAUSE_MS = 300;

/** The results panel's model: a query typed (searched after a short pause, or at once on submit), paged with "see more". */
export function createSearch({ request, scope, delayMs = TYPING_PAUSE_MS }: { request: AuthClient["request"]; scope: SearchScope; delayMs?: number }) {
  const store = createStore<SearchState>(() => IDLE);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let run = 0; // a newer search or a close makes older answers irrelevant
  const patch = (p: Partial<SearchState>) => store.setState(p);

  async function search() {
    const q = normalizeQuery(store.getState().query);
    const mine = ++run;
    if (!q) return patch({ status: "idle", results: [], hasMore: false, loadingMore: false, moreFailed: false });
    patch({ status: "loading", loadingMore: false, moreFailed: false });
    try {
      const r = await request<SearchResponse<Message>>("GET", searchPath(scope, q));
      if (mine === run) patch({ status: "ready", results: r.messages, hasMore: r.hasMore });
    } catch {
      if (mine === run) patch({ status: "error", results: [], hasMore: false });
    }
  }

  return {
    store,
    setQuery(query: string) {
      clearTimeout(timer);
      patch({ query });
      timer = setTimeout(() => void search(), delayMs);
    },
    /** Enter: search now. */
    submit() {
      clearTimeout(timer);
      return search();
    },
    async loadMore() {
      const s = store.getState();
      const q = normalizeQuery(s.query);
      const last = s.results[s.results.length - 1];
      if (!q || !last || !s.hasMore || s.loadingMore || s.status !== "ready") return;
      const mine = run;
      patch({ loadingMore: true, moreFailed: false });
      try {
        const r = await request<SearchResponse<Message>>("GET", searchPath(scope, q, last.seq));
        if (mine === run) patch({ results: [...store.getState().results, ...r.messages], hasMore: r.hasMore, loadingMore: false });
      } catch {
        if (mine === run) patch({ loadingMore: false, moreFailed: true });
      }
    },
    /** The panel closed or the conversation changed: forget everything and ignore answers still on the way. */
    reset() {
      clearTimeout(timer);
      run++;
      store.setState(IDLE);
    },
  };
}
export type Search = ReturnType<typeof createSearch>;
