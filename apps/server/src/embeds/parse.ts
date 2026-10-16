/**
 * Open Graph / Twitter card / <title> / meta description out of fetched HTML, as plain strings. A few linear
 * regex scans, no DOM, no script, no subresource: the HTML is only ever read as text.
 */
export const MAX = { title: 150, description: 300, siteName: 60 };

export type Preview = { siteName: string | null; title: string | null; description: string | null; image: string | null };

// Linear time on hostile input: tags are bounded, and an attribute name may only start after a separator, so a
// long run of letters is scanned once rather than once per position.
const META = /<meta\b[^>]{0,4096}>/gi;
const ATTR = /(?<=[\s"'/])([a-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const TITLE = /<title\b[^>]{0,256}>([^<]{0,2048})<\/title>/i;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// C0/C1 controls and bidi overrides/isolates (the same family `sanitizeFilename` strips).
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });

/** Entities decoded, unsafe characters dropped, whitespace collapsed, cut to `max` characters (code points). */
export function clean(raw: string | undefined, max: number): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw).replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

/** Null when the page offers nothing to show (no title and no description). `pageUrl` resolves a relative image. */
export function parsePreview(html: string, pageUrl: string): Preview | null {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(META)) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(ATTR)) attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    const key = (attrs.property ?? attrs.name)?.toLowerCase();
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content); // first one wins
  }
  const title = clean(meta.get("og:title") ?? meta.get("twitter:title") ?? TITLE.exec(html)?.[1], MAX.title);
  const description = clean(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"), MAX.description);
  if (!title && !description) return null;
  const host = new URL(pageUrl).hostname.replace(/^www\./, "");
  let image: string | null = null;
  const rawImage = (meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image") ?? meta.get("twitter:image:src"))?.trim();
  if (rawImage) {
    try {
      const u = new URL(decodeEntities(rawImage), pageUrl);
      if (u.protocol === "http:" || u.protocol === "https:") image = u.href;
    } catch {
      // not a URL: no thumbnail
    }
  }
  return { siteName: clean(meta.get("og:site_name"), MAX.siteName) ?? clean(host, MAX.siteName), title, description, image };
}
