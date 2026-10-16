import { isGifUrl } from "./gifs.js";

/** Link previews: at most this many distinct URLs of one message are unfurled (in the order they appear). */
export const MAX_EMBEDS_PER_MESSAGE = 3;

/** What a message JSON carries per preview (`thumbnail`: an API path, or null). */
export type MessageEmbed = { url: string; siteName: string | null; title: string | null; description: string | null; thumbnail: string | null };

const TRAILING = /[.,;:!?'"…)\]}]$/;

/** Sentence punctuation after a link is not part of it; a ")" stays when the link opened one (wiki links). */
export function trimUrlTrailing(url: string): string {
  while (TRAILING.test(url)) {
    if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    url = url.slice(0, -1);
  }
  return url;
}

// Code (fenced or inline) and `<https://...>` (a deliberately suppressed preview) never unfurl.
const SKIPPED = /```[\s\S]*?```|(`+)[\s\S]*?\1|<https?:\/\/[^\s>]*>/gi;
const CANDIDATE = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>"]+/giu;

/**
 * The URLs of `content` worth a preview, as normalised hrefs (WHATWG parsing, so "HTTP://Example.com" and
 * "http://example.com/" are one), distinct, first `max` in order of appearance. Only http(s) with a host; whether
 * the host may be fetched at all is the fetcher's call, not this one's. GIF URLs are skipped.
 */
export function linkPreviewUrls(content: string, max = MAX_EMBEDS_PER_MESSAGE): string[] {
  const urls: string[] = [];
  for (const [raw] of content.replace(SKIPPED, " ").matchAll(CANDIDATE)) {
    let href: string;
    try {
      const u = new URL(trimUrlTrailing(raw));
      if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) continue;
      href = u.href;
      if (isGifUrl(href)) continue; // an image, not a page: nothing to unfurl
    } catch {
      continue;
    }
    if (!urls.includes(href)) urls.push(href);
    if (urls.length === max) break;
  }
  return urls;
}
