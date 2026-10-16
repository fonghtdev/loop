import { type GifPage, type GifResult, isGifUrl } from "@loop/shared";

/**
 * The GIPHY client. Not a user-URL fetcher: the host and path are fixed here and the user only supplies values that
 * are URL-encoded into the query, so `embeds/fetch.ts` (the only fetcher of user-supplied URLs) is not involved.
 * ponytail: one provider (GIPHY); Tenor (same shape: search + featured, media_formats) is the alternative if its
 * terms or quota stop working for us. The API key stays in this module and in the outbound URL: never in a response or a log.
 */
const BASE = "https://api.giphy.com/v1/gifs";
const TIMEOUT_MS = 5_000;
const MAX_BODY = 1024 * 1024;
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 2000;
const CACHE_ENTRIES = 100;
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Fetches one provider URL and returns its parsed JSON; throws on anything but a small, successful JSON answer. */
export type GiphyFetch = (url: string) => Promise<unknown>;

export const fetchJson: GiphyFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
  if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

type Rendition = { url?: unknown; width?: unknown; height?: unknown; size?: unknown };
const object = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const dimension = (v: unknown) => (/^\d{1,4}$/.test(String(v)) && Number(v) >= 1 && Number(v) <= MAX_DIMENSION ? Number(v) : null);

/** A rendition we may hand to clients: an allowlisted https URL, sane size, and (when stated) at most 8 MB. */
function usable(r: Rendition) {
  const width = dimension(r.width);
  const height = dimension(r.height);
  const bytes = r.size === undefined || r.size === "" ? 0 : Number(r.size);
  if (typeof r.url !== "string" || !isGifUrl(r.url) || !width || !height || !(bytes >= 0 && bytes <= MAX_GIF_BYTES)) return null;
  return { url: r.url, width, height };
}

// eslint-disable-next-line no-control-regex
const cleanTitle = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 100) : "");

/** One provider item -> our result, or null when it has no rendition that passes (hostile or odd payloads are dropped). */
export function toResult(item: unknown): GifResult | null {
  const { id, title, images } = object(item);
  const img = object(images);
  const full = usable(object(img.fixed_height)) ?? usable(object(img.original));
  if (typeof id !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(id) || !full) return null;
  const preview = usable(object(img.fixed_width_small)) ?? full;
  // the size rides in the URL fragment (never sent to the CDN) so a message that is only this URL can draw its box
  return { id, title: cleanTitle(title), previewUrl: preview.url, url: `${full.url.split("#")[0]}#w=${full.width}&h=${full.height}`, width: full.width, height: full.height };
}

export function toPage(body: unknown, offset: number): GifPage {
  const { data, pagination } = object(body);
  if (!Array.isArray(data)) throw new Error("unexpected provider answer");
  const total = Number(object(pagination).total_count);
  const next = offset + data.length;
  return {
    results: data.map(toResult).filter((r): r is GifResult => r !== null),
    nextOffset: data.length > 0 && Number.isFinite(total) && next < total && next <= 4999 ? next : null,
  };
}

export function createGiphy(apiKey: string, { fetchJson: get = fetchJson, ttlMs = CACHE_TTL_MS }: { fetchJson?: GiphyFetch; ttlMs?: number } = {}) {
  const cache = new Map<string, { page: GifPage; expires: number }>(); // Map order = least recently used first
  return async function load(kind: "search" | "trending", params: { q?: string; offset: number; limit: number }): Promise<GifPage> {
    const query = new URLSearchParams(kind === "search" ? { q: params.q ?? "" } : {});
    for (const [k, v] of Object.entries({ offset: params.offset, limit: params.limit, rating: "pg-13", lang: "vi", bundle: "messaging_non_clips" })) query.set(k, String(v));
    const key = `${kind}?${query}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.page;
    }
    query.set("api_key", apiKey);
    const page = toPage(await get(`${BASE}/${kind}?${query}`), params.offset);
    cache.delete(key);
    cache.set(key, { page, expires: Date.now() + ttlMs });
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return page;
  };
}
