import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { gifSize, type GifPage, type GifResult } from "@loop/shared";
import type { Method } from "./auth-client";
import { createFlagPref } from "./embeds";

type Request = <T>(method: Method, path: string, body?: unknown) => Promise<T>;

/** "Show GIFs", per device. Off: GIF links stay plain links and the picker is hidden, so nothing is loaded from GIPHY. */
export const gifPref = createFlagPref("loop.showGifs", () => globalThis.window?.localStorage);
export const useShowGifs = () => useSyncExternalStore(gifPref.subscribe, gifPref.get);

export const gifApi = (request: Request) => ({
  enabled: () => request<{ enabled: boolean }>("GET", "/gifs/config").then((c) => c.enabled),
  search: (q: string, offset: number) => request<GifPage>("GET", `/gifs/search?${new URLSearchParams({ q, offset: String(offset) })}`),
  trending: (offset: number) => request<GifPage>("GET", `/gifs/trending?${new URLSearchParams({ offset: String(offset) })}`),
});
export type GifApi = Pick<ReturnType<typeof gifApi>, "search" | "trending">;

/** The server says whether it has a GIF provider; an old server (404) or a failure means no GIF button. */
export const useGifsAvailable = (request: Request) =>
  useQuery({ queryKey: ["gifs", "config"], queryFn: gifApi(request).enabled, staleTime: Infinity, retry: false }).data === true;

export const DEBOUNCE_MS = 300;
const DEFAULT_BOX = { width: 240, height: 180 };
const MAX_BOX = { width: 320, height: 240 };

/** The box a GIF message reserves before the picture loads: its size hint (or a default) scaled into 320x240, never enlarged. */
export function gifBox(url: string): { width: number; height: number } {
  const { width, height } = gifSize(url) ?? DEFAULT_BOX;
  const scale = Math.min(1, MAX_BOX.width / width, MAX_BOX.height / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export type PickerState = { query: string; results: GifResult[]; nextOffset: number | null; phase: "loading" | "ready" | "error"; loadingMore: boolean };

/**
 * What the GIF popover shows: trending while the box is empty, else the search of its text (typing is debounced; an
 * empty box shows trending at once). A newer question makes every older answer irrelevant: only the latest request may
 * change the state (the older ones still finish, their results are dropped; the REST client has no abort).
 */
export function createGifPicker(api: GifApi, debounceMs = DEBOUNCE_MS) {
  const listeners = new Set<() => void>();
  let state: PickerState = { query: "", results: [], nextOffset: null, phase: "loading", loadingMore: false };
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (patch: Partial<PickerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  async function load(query: string, offset: number) {
    const mine = ++latest;
    try {
      const page = await (query ? api.search(query, offset) : api.trending(offset));
      if (mine !== latest) return;
      const have = new Set(offset ? state.results.map((r) => r.id) : []);
      set({ results: [...(offset ? state.results : []), ...page.results.filter((r) => !have.has(r.id))], nextOffset: page.nextOffset, phase: "ready", loadingMore: false });
    } catch {
      if (mine === latest) set({ phase: "error", loadingMore: false });
    }
  }

  const restart = (query: string) => {
    clearTimeout(timer);
    set({ query, results: [], nextOffset: null, phase: "loading", loadingMore: false });
    void load(query, 0);
  };

  return {
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    start: () => restart(""),
    retry: () => restart(state.query),
    setQuery(raw: string) {
      const query = raw.trim();
      if (query === state.query && state.phase !== "error") return;
      if (!query) return restart("");
      latest++; // whatever is in flight is stale from now on, even before the debounce fires
      clearTimeout(timer);
      set({ query, results: [], nextOffset: null, phase: "loading", loadingMore: false });
      timer = setTimeout(() => void load(query, 0), debounceMs);
    },
    more() {
      if (state.nextOffset === null || state.loadingMore || state.phase !== "ready") return;
      set({ loadingMore: true });
      void load(state.query, state.nextOffset);
    },
    dispose() {
      latest++;
      clearTimeout(timer);
    },
  };
}
