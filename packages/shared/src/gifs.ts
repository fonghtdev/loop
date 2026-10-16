import { z } from "zod";

/** The only hosts a GIF may be served from (GIPHY's CDN). Exact names: no wildcard, so the desktop CSP can list them. */
export const GIF_HOSTS = ["media0.giphy.com", "media1.giphy.com", "media2.giphy.com", "media3.giphy.com", "media4.giphy.com", "i.giphy.com"] as const;

/** A plain https URL on a GIF host: no credentials, no port. Anything else (lookalikes, http, javascript:) is false. */
export function isGifUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && (GIF_HOSTS as readonly string[]).includes(u.hostname);
  } catch {
    return false;
  }
}

/** The URL when the WHOLE message (trimmed) is one GIF URL, else null: a GIF inside longer text stays a link. */
export function wholeGifUrl(content: string): string | null {
  const text = content.trim();
  return text && !/\s/.test(text) && isGifUrl(text) ? text : null;
}

/** Size hint the server appends as `#w=<px>&h=<px>`; clamped, because anyone can type a URL by hand. null = no usable hint. */
export function gifSize(url: string): { width: number; height: number } | null {
  const p = new URLSearchParams(url.split("#")[1] ?? "");
  const [width, height] = [Number(p.get("w")), Number(p.get("h"))];
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 2000 && height <= 2000 ? { width, height } : null;
}

export const GIF_PAGE_MAX = 30;
export const gifSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).refine((s) => !/[\u0000-\u001f\u007f]/.test(s)),
    offset: z.coerce.number().int().min(0).max(4999).default(0),
    limit: z.coerce.number().int().min(1).max(GIF_PAGE_MAX).default(24),
  })
  .strict();
export const gifTrendingQuerySchema = gifSearchQuerySchema.omit({ q: true });

/** What `GET /gifs/search` and `/gifs/trending` answer. `url` is what a message carries; `previewUrl` is the small one. */
export type GifResult = { id: string; title: string; previewUrl: string; url: string; width: number; height: number };
export type GifPage = { results: GifResult[]; nextOffset: number | null };
